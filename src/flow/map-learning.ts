import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { RunGateUnitOfWork } from "../runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import { redactSensitive } from "../security/redaction.js";
import {
  APPROVED_LEARNING_CONTROL_IDS,
  EvidenceReceiptSchema,
  FindingLifecycleSchema,
  validateFindingLifecycle,
  type EvidenceReceipt,
} from "./learning-policy.js";
import { FlowEvidenceLedger } from "./evidence-ledger.js";

const MAX_HANDOFF_BYTES = 1024 * 1024;
const MAX_TASK_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDS = 1024;
const MAX_DIRECTORY_ENTRIES = MAX_RECORDS * 2;
const MAX_REFERENCES = 256;
const MAX_PROMOTION_DATABASE_BYTES = 64 * 1024 * 1024;
const PROMOTION_DATABASE_SIDECARS = ["-journal", "-wal", "-shm"] as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MapVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const FindingIdSchema = z.string().regex(/^FIND-\d{3,}$/);
const ControlIdSchema = z.string().regex(/^CTRL-\d{3}$/);
const ConsumerScopeSchema = z.enum(["codex", "grok", "claude"]);
const LegacyConsumerScopeSchema = z.enum(["codex", "grok"]);
const LEARNING_CONSUMERS = ["codex", "grok", "claude"] as const;
const LearningReviewReceiptSchema = z.object({
  schemaVersion: z.literal("learning-review-receipt/v1"),
  reviewId: z.string().min(1),
  agent: z.enum(["codex", "grok", "claude"]),
  role: z.enum(["auditor", "critic"]),
  sessionId: z.uuid(),
  attemptId: z.uuid(),
  taskPacketSha256: Sha256Schema,
  candidateSha256: Sha256Schema,
  verdict: z.literal("PASS"),
}).strict();
const FindingClosureSchema = z.object({
  findingId: FindingIdSchema,
  status: z.literal("closed"),
  rootCauseSha256: Sha256Schema,
  regressionOracleSha256: Sha256Schema,
  siblingScanSha256: Sha256Schema,
}).strict();
const MapLearningProfileSchema = z.object({
  mapVersion: MapVersionSchema,
  mapManifestSha256: Sha256Schema,
}).strict();
const MapLearningHeadSchema = z.object({
  schemaVersion: z.literal("map-learning-head/v1"),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  recordId: Sha256Schema,
  mapVersion: MapVersionSchema,
  mapManifestSha256: Sha256Schema,
}).strict();
const PromotionJournalSchema = z.object({
  schemaVersion: z.literal("map-learning-promotion-journal/v1"),
  phase: z.enum(["prepared", "published"]),
  previousHead: MapLearningHeadSchema.nullable(),
  recordId: Sha256Schema,
  recordExisted: z.boolean(),
}).strict();
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const LearningHandoffSchema = z.object({
  schemaVersion: z.literal("learning-handoff/v1"),
  taskPacketSha256: Sha256Schema,
  mapVersion: MapVersionSchema,
  mapManifestSha256: Sha256Schema,
  candidateSha256: Sha256Schema,
  findingIds: z.array(FindingIdSchema).min(1).max(MAX_REFERENCES)
    .refine(unique, "learning handoff finding IDs must be unique"),
  findingClosures: z.array(FindingClosureSchema).min(1).max(MAX_REFERENCES),
  reviewReceipts: z.array(LearningReviewReceiptSchema).length(6),
}).strict().superRefine((value, context) => {
  const closureIds = value.findingClosures.map(({ findingId }) => findingId).sort();
  if (!unique(closureIds) || JSON.stringify(closureIds) !== JSON.stringify([...value.findingIds].sort())) {
    context.addIssue({ code: "custom", message: "learning finding closures must match the exact finding IDs" });
  }
  const pairs = value.reviewReceipts.map(({ agent, role }) => `${agent}:${role}`).sort();
  const expected = [
    "claude:auditor",
    "claude:critic",
    "codex:auditor",
    "codex:critic",
    "grok:auditor",
    "grok:critic",
  ];
  if (JSON.stringify(pairs) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "learning promotion requires six independent review receipts" });
  }
  if (value.reviewReceipts.some(({ candidateSha256 }) => candidateSha256 !== value.candidateSha256)) {
    context.addIssue({ code: "custom", message: "learning review receipt candidate digest mismatch" });
  }
  if (value.reviewReceipts.some(({ taskPacketSha256 }) => taskPacketSha256 !== value.taskPacketSha256)) {
    context.addIssue({ code: "custom", message: "learning review receipt task packet digest mismatch" });
  }
});

export const MapLearningCandidateSchema = z.object({
  schemaVersion: z.literal("map-learning-candidate/v1"),
  rule: z.string().min(1).max(16 * 1024).refine(
    (rule) => rule.trim() === rule,
    "learning rule must not have surrounding whitespace",
  ),
  controlIds: z.array(ControlIdSchema).min(1).max(MAX_REFERENCES)
    .refine(unique, "learning control IDs must be unique"),
  consumerScopes: z.array(ConsumerScopeSchema).length(3)
    .refine(unique, "learning consumer scopes must be unique")
    .refine(
      (scopes) => scopes.includes("codex") && scopes.includes("grok") && scopes.includes("claude"),
      "provider-neutral learning must include Codex, Grok, and Claude",
    ),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const MapLearningTaskPacketSchema = z.object({
  schemaVersion: z.literal("map-learning-task-packet/v1"),
  projectRoot: z.string().startsWith("/"),
  stageId: z.literal("90_learning_close"),
  sourceFingerprint: Sha256Schema,
  reviewId: z.string().min(1),
  candidateSha256: Sha256Schema,
  candidate: MapLearningCandidateSchema,
  evidenceReceipts: z.array(EvidenceReceiptSchema).min(3).max(MAX_REFERENCES),
  findingLifecycles: z.array(FindingLifecycleSchema).min(1).max(MAX_REFERENCES),
}).strict().superRefine((packet, context) => {
  if (!unique(packet.evidenceReceipts.map(({ id }) => id))) {
    context.addIssue({ code: "custom", message: "learning task evidence IDs must be unique" });
  }
  if (!unique(packet.findingLifecycles.map(({ findingId }) => findingId))) {
    context.addIssue({ code: "custom", message: "learning task finding IDs must be unique" });
  }
  if (packet.candidateSha256 !== sha256(candidateBytes(normalizeCandidate(packet.candidate)))) {
    context.addIssue({ code: "custom", message: "learning task candidate digest mismatch" });
  }
});

const LegacyMapLearningRecordSchema = z.object({
  schemaVersion: z.literal("map-learning-record/v1"),
  recordId: Sha256Schema,
  taskPacketSha256: Sha256Schema,
  handoffSha256: Sha256Schema,
  candidateSha256: Sha256Schema,
  mapVersion: MapVersionSchema,
  mapManifestSha256: Sha256Schema,
  findingIds: z.array(FindingIdSchema).min(1).max(MAX_REFERENCES).refine(unique),
  rule: z.string().min(1).max(16 * 1024),
  controlIds: z.array(ControlIdSchema).min(1).max(MAX_REFERENCES).refine(unique),
  consumerScopes: z.array(LegacyConsumerScopeSchema).length(2).refine(unique)
    .refine(
      (scopes) => scopes.includes("codex") && scopes.includes("grok"),
      "legacy learning must include Codex and Grok",
    ),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const CurrentMapLearningRecordSchema = z.object({
  schemaVersion: z.literal("map-learning-record/v2"),
  recordId: Sha256Schema,
  taskPacketSha256: Sha256Schema,
  handoffSha256: Sha256Schema,
  candidateSha256: Sha256Schema,
  mapVersion: MapVersionSchema,
  mapManifestSha256: Sha256Schema,
  findingIds: z.array(FindingIdSchema).min(1).max(MAX_REFERENCES).refine(unique),
  rule: z.string().min(1).max(16 * 1024),
  controlIds: z.array(ControlIdSchema).min(1).max(MAX_REFERENCES).refine(unique),
  consumerScopes: z.array(ConsumerScopeSchema).length(3).refine(unique)
    .refine(
      (scopes) => scopes.includes("codex") && scopes.includes("grok") && scopes.includes("claude"),
      "provider-neutral learning must include Codex, Grok, and Claude",
    ),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const MapLearningRecordSchema = z.discriminatedUnion("schemaVersion", [
  LegacyMapLearningRecordSchema,
  CurrentMapLearningRecordSchema,
]);

const MapLearningCloseInputSchema = z.object({
  taskPacketBytes: z.instanceof(Uint8Array).refine(
    (bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_TASK_PACKET_BYTES,
    "learning task packet exceeds the allowed byte size",
  ),
  handoffBytes: z.instanceof(Uint8Array).refine(
    (bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_HANDOFF_BYTES,
    "learning handoff exceeds the allowed byte size",
  ),
  candidate: z.unknown(),
  mapVersion: MapVersionSchema,
  mapManifestSha256: Sha256Schema,
}).strict();

export type LearningHandoff = z.infer<typeof LearningHandoffSchema>;
export type MapLearningCandidate = z.infer<typeof MapLearningCandidateSchema>;
export type MapLearningRecord = z.infer<typeof MapLearningRecordSchema>;
export type LearningConsumer = z.infer<typeof ConsumerScopeSchema>;
export type MapLearningProfile = z.infer<typeof MapLearningProfileSchema>;
type MapLearningHead = z.infer<typeof MapLearningHeadSchema>;
type PromotionJournal = z.infer<typeof PromotionJournalSchema>;

export interface MapLearningCloseInput {
  taskPacketBytes: Uint8Array;
  handoffBytes: Uint8Array;
  candidate: unknown;
  mapVersion: string;
  mapManifestSha256: string;
}

export interface MapLearningProjection {
  bytes: Uint8Array;
  digest: string;
}

/** @internal */
export interface MapLearningRuntimeAuthority {
  databasePath: string;
  controlFingerprint?: () => string;
  promotionCheckpoint?: (phase: "before_publish" | "after_publish") => void;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function parseHandoff(bytes: Uint8Array): LearningHandoff {
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`invalid learning handoff schema: ${String(error)}`);
  }
  const parsed = LearningHandoffSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid learning handoff schema: ${parsed.error.message}`);
  return parsed.data;
}

function parseCandidate(input: unknown): MapLearningCandidate {
  const parsed = MapLearningCandidateSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid MAP learning candidate schema: ${parsed.error.message}`);
  return {
    ...parsed.data,
    controlIds: [...parsed.data.controlIds].sort(),
    consumerScopes: [...LEARNING_CONSUMERS],
  };
}

function normalizeCandidate(candidate: MapLearningCandidate): MapLearningCandidate {
  return {
    ...candidate,
    controlIds: [...candidate.controlIds].sort(),
    consumerScopes: [...LEARNING_CONSUMERS],
  };
}

function candidateBytes(candidate: MapLearningCandidate): Uint8Array {
  return jsonBytes(candidate);
}

type MapLearningTaskPacket = z.infer<typeof MapLearningTaskPacketSchema>;

function parseTaskPacket(bytes: Uint8Array): MapLearningTaskPacket {
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`invalid MAP learning task packet JSON: ${String(error)}`);
  }
  const parsed = MapLearningTaskPacketSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid MAP learning task packet schema: ${parsed.error.message}`);
  const canonical: MapLearningTaskPacket = {
    ...parsed.data,
    candidate: normalizeCandidate(parsed.data.candidate),
    evidenceReceipts: [...parsed.data.evidenceReceipts].sort((left, right) => left.id.localeCompare(right.id)),
    findingLifecycles: [...parsed.data.findingLifecycles]
      .sort((left, right) => left.findingId.localeCompare(right.findingId)),
  };
  if (!Buffer.from(bytes).equals(Buffer.from(jsonBytes(canonical)))) {
    throw new Error("MAP learning task packet must use exact canonical JSON bytes");
  }
  return canonical;
}

function canonicalEvidenceDigest(receipt: EvidenceReceipt): string {
  return sha256(jsonBytes(EvidenceReceiptSchema.parse(receipt)));
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function verifyLearningProvenance(input: {
  projectRoot: string;
  taskPacketBytes: Uint8Array;
  handoff: LearningHandoff;
  candidate: MapLearningCandidate;
  authority: MapLearningRuntimeAuthority;
}): void {
  const reviews = new RunGateUnitOfWork(input.authority.databasePath);
  const evidenceLedger = new FlowEvidenceLedger(input.authority.databasePath, {
    ...(input.authority.controlFingerprint
      ? { controlFingerprint: input.authority.controlFingerprint }
      : {}),
  });
  try {
  const taskPacket = parseTaskPacket(input.taskPacketBytes);
  const taskPacketSha256 = sha256(input.taskPacketBytes);
  if (taskPacket.projectRoot !== input.projectRoot) {
    throw new Error("learning task packet project root mismatch");
  }
  if (taskPacket.candidateSha256 !== sha256(candidateBytes(input.candidate)) ||
      JSON.stringify(taskPacket.candidate) !== JSON.stringify(input.candidate)) {
    throw new Error("learning task packet does not bind the exact candidate");
  }
  if (captureWorkspaceFingerprint(input.projectRoot).fingerprint !== taskPacket.sourceFingerprint) {
    throw new Error("learning task packet source fingerprint is stale at promotion time");
  }
  const evidence = taskPacket.evidenceReceipts;
  evidenceLedger.requireExact(evidence, taskPacket.findingLifecycles);
  const lifecycles = taskPacket.findingLifecycles.map((finding) =>
    validateFindingLifecycle(evidence, finding));
  if (lifecycles.some(({ status }) => status !== "closed") ||
      !sameSorted(lifecycles.map(({ findingId }) => findingId), input.handoff.findingIds)) {
    throw new Error("learning task packet does not contain the exact closed finding set");
  }
  if (!sameSorted(lifecycles.map(({ affectedControlId }) => affectedControlId), input.candidate.controlIds)) {
    throw new Error("learning candidate controls do not match the validated finding controls");
  }
  const receiptById = new Map(evidence.map((receipt) => [receipt.id, receipt]));
  const closureById = new Map(input.handoff.findingClosures.map((closure) => [closure.findingId, closure]));
  for (const lifecycle of lifecycles) {
    const closure = closureById.get(lifecycle.findingId);
    const details = lifecycle.closure!;
    const regression = receiptById.get(details.regressionEvidenceId);
    const sibling = receiptById.get(details.siblingScanEvidenceId);
    if (!closure || !regression || !sibling ||
        closure.rootCauseSha256 !== sha256(lifecycle.rootCause!) ||
        closure.regressionOracleSha256 !== canonicalEvidenceDigest(regression) ||
        closure.siblingScanSha256 !== canonicalEvidenceDigest(sibling)) {
      throw new Error("learning handoff closure does not match the validated finding lifecycle");
    }
    for (const receiptId of [details.fixEvidenceId, details.regressionEvidenceId, details.siblingScanEvidenceId]) {
      const receipt = receiptById.get(receiptId)!;
      if (receipt.sourceFingerprint !== taskPacket.sourceFingerprint ||
          receipt.artifactHash !== taskPacket.candidateSha256 ||
          receipt.cwd !== input.projectRoot) {
        throw new Error("learning finding evidence does not bind the task source and candidate");
      }
    }
  }

  const review = reviews.get(taskPacket.reviewId);
    if (!review || review.reviewId !== input.handoff.reviewReceipts[0]?.reviewId ||
        review.stageId !== taskPacket.stageId || review.project !== input.projectRoot ||
        review.requester !== "codex" || review.approvalScope !== "workspace-read" ||
        review.sourceFingerprint !== taskPacket.sourceFingerprint ||
        review.artifactHash !== taskPacketSha256 ||
        !Buffer.from(review.artifact).equals(Buffer.from(input.taskPacketBytes)) ||
        !reviews.barrier(review.reviewId).satisfied) {
      throw new Error("learning review barrier lacks exact launched durable PASS evidence");
    }
    for (const receipt of input.handoff.reviewReceipts) {
      const lane = review.lanes.find(({ agent, role }) => agent === receipt.agent && role === receipt.role);
      const attempt = lane?.attempts.at(-1);
      if (!lane || !attempt || receipt.reviewId !== review.reviewId ||
          receipt.sessionId !== attempt.sessionId || receipt.attemptId !== attempt.attemptId ||
          receipt.taskPacketSha256 !== taskPacketSha256 ||
          receipt.candidateSha256 !== taskPacket.candidateSha256) {
        throw new Error("learning review receipt does not match durable harness evidence");
      }
  }
  } finally {
    evidenceLedger.close();
    reviews.close();
  }
}

function recordAddress(handoffSha256: string, candidateSha256: string): string {
  return sha256(`${handoffSha256}\n${candidateSha256}\n`);
}

function recordCandidateBytes(record: MapLearningRecord): Uint8Array {
  return jsonBytes({
    schemaVersion: "map-learning-candidate/v1" as const,
    rule: record.rule,
    controlIds: [...record.controlIds],
    consumerScopes: [...record.consumerScopes],
    revision: record.revision,
  });
}

function validateStoredRecord(path: string, expectedBytes?: Uint8Array): MapLearningRecord {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("learning record is not a regular file");
  }
  if (metadata.size <= 0 || metadata.size > MAX_RECORD_BYTES) {
    throw new Error("learning record exceeds the allowed byte size");
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (expectedBytes !== undefined && !Buffer.from(bytes).equals(Buffer.from(expectedBytes))) {
    throw new Error("content-addressed learning record is corrupt or collided");
  }
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    throw new Error(`invalid durable learning record schema: ${String(error)}`);
  }
  const parsed = MapLearningRecordSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid durable learning record schema: ${parsed.error.message}`);
  const record = parsed.data;
  const canonicalCandidateSha256 = sha256(recordCandidateBytes(record));
  if (record.candidateSha256 !== canonicalCandidateSha256) {
    throw new Error("durable learning candidate digest is stale");
  }
  if (record.recordId !== recordAddress(record.handoffSha256, record.candidateSha256)) {
    throw new Error("durable learning record address is stale");
  }
  return record;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalExistingDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(path) !== path) {
    throw new Error(`${label} is not a canonical directory`);
  }
}

function canonicalProjectRoot(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  if (absolute !== projectRoot) {
    throw new Error("MAP learning project root must be an exact absolute path");
  }
  let cursor = parse(absolute).root;
  for (const component of relative(cursor, absolute).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink()) {
      throw new Error("MAP learning project root is missing or crosses a symbolic link");
    }
  }
  canonicalExistingDirectory(absolute, "MAP learning project root");
  return absolute;
}

function ensureContainedLearningDirectories(projectRoot: string): void {
  let cursor = projectRoot;
  for (const component of [".map", "agent-collab-admin", "learning", "records"]) {
    cursor = join(cursor, component);
    try {
      mkdirSync(cursor, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    canonicalExistingDirectory(cursor, "MAP learning administration path");
  }
}

interface PromotionDatabaseIdentity {
  dev: number;
  ino: number;
}

function requireSecurePromotionFile(path: string, label: string): PromotionDatabaseIdentity {
  const metadata = lstatSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_PROMOTION_DATABASE_BYTES ||
    realpathSync(path) !== path
  ) {
    throw new Error(`${label} is not a bounded canonical regular file`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

function requireSecurePromotionSidecars(databasePath: string): void {
  for (const suffix of PROMOTION_DATABASE_SIDECARS) {
    const path = `${databasePath}${suffix}`;
    if (!existsSync(path)) continue;
    requireSecurePromotionFile(path, `MAP learning promotion database${suffix}`);
    chmodSync(path, 0o600);
  }
}

function preparePromotionDatabase(path: string, administrationRoot: string): PromotionDatabaseIdentity {
  requireSecurePromotionSidecars(path);
  if (!existsSync(path)) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      fsyncSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    if (descriptor !== undefined) syncDirectory(administrationRoot);
  }
  const identity = requireSecurePromotionFile(path, "MAP learning promotion database");
  chmodSync(path, 0o600);
  return identity;
}

function requireUnchangedPromotionDatabase(path: string, expected: PromotionDatabaseIdentity): void {
  const actual = requireSecurePromotionFile(path, "MAP learning promotion database");
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("MAP learning promotion database identity changed while opening");
  }
  requireSecurePromotionSidecars(path);
}

function readHead(path: string): MapLearningHead | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_RECORD_BYTES) {
    throw new Error("MAP learning head is not a bounded regular file");
  }
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(new Uint8Array(readFileSync(path))));
  } catch (error) {
    throw new Error(`invalid MAP learning head JSON: ${String(error)}`);
  }
  const parsed = MapLearningHeadSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid MAP learning head schema: ${parsed.error.message}`);
  return parsed.data;
}

function writeHeadAtomic(administrationRoot: string, path: string, head: MapLearningHead): void {
  const temporaryPath = join(
    administrationRoot,
    `.head.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, jsonBytes(head));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    syncDirectory(administrationRoot);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function readPromotionJournal(path: string): PromotionJournal | null {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
      metadata.size <= 0 || metadata.size > MAX_RECORD_BYTES || realpathSync(path) !== path) {
    throw new Error("MAP learning promotion journal is not a bounded canonical regular file");
  }
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(new Uint8Array(readFileSync(path))));
  } catch (error) {
    throw new Error(`invalid MAP learning promotion journal JSON: ${String(error)}`);
  }
  const parsed = PromotionJournalSchema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid MAP learning promotion journal schema: ${parsed.error.message}`);
  return parsed.data;
}

function writePromotionJournalAtomic(
  administrationRoot: string,
  path: string,
  journal: PromotionJournal,
): void {
  if (existsSync(path)) readPromotionJournal(path);
  const temporaryPath = join(
    administrationRoot,
    `.promotion-journal.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, jsonBytes(PromotionJournalSchema.parse(journal)));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    syncDirectory(administrationRoot);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function removePromotionJournal(administrationRoot: string, path: string): void {
  if (!existsSync(path)) return;
  readPromotionJournal(path);
  unlinkSync(path);
  syncDirectory(administrationRoot);
}

function rollbackPromotionJournal(
  administrationRoot: string,
  recordsRoot: string,
  headPath: string,
  journalPath: string,
): void {
  const journal = readPromotionJournal(journalPath);
  if (journal === null) return;
  if (journal.previousHead === null) {
    if (existsSync(headPath)) {
      const headMetadata = lstatSync(headPath);
      if (headMetadata.isSymbolicLink() || !headMetadata.isFile()) {
        throw new Error("MAP learning head cannot be recovered safely");
      }
      unlinkSync(headPath);
      syncDirectory(administrationRoot);
    }
  } else {
    validateStoredRecord(join(recordsRoot, `${journal.previousHead.recordId}.json`));
    writeHeadAtomic(administrationRoot, headPath, journal.previousHead);
  }
  const recordPath = join(recordsRoot, `${journal.recordId}.json`);
  if (!journal.recordExisted && existsSync(recordPath)) {
    const recordMetadata = lstatSync(recordPath);
    if (recordMetadata.isSymbolicLink() || !recordMetadata.isFile()) {
      throw new Error("MAP learning record cannot be recovered safely");
    }
    unlinkSync(recordPath);
    syncDirectory(recordsRoot);
  }
  removePromotionJournal(administrationRoot, journalPath);
}

function publishExclusive(recordsRoot: string, record: MapLearningRecord): MapLearningRecord {
  const finalPath = join(recordsRoot, `${record.recordId}.json`);
  const bytes = jsonBytes(record);
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error("learning record exceeds the allowed byte size");
  if (existsSync(finalPath)) return validateStoredRecord(finalPath, bytes);

  const temporaryPath = join(
    recordsRoot,
    `.${record.recordId}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporaryPath, finalPath);
      syncDirectory(recordsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  syncDirectory(recordsRoot);
  return validateStoredRecord(finalPath, bytes);
}

class MapLearningRegistry {
  readonly projectRoot: string;
  readonly recordsRoot: string;
  readonly administrationRoot: string;
  readonly headPath: string;
  readonly promotionJournalPath: string;
  readonly promotionDatabasePath: string;

  constructor(
    projectRoot: string,
    private readonly authority?: MapLearningRuntimeAuthority,
    private readonly revalidateProfile?: () => void,
  ) {
    if (projectRoot.length === 0 || projectRoot.trim() !== projectRoot) {
      throw new Error("MAP learning project root must be a non-empty exact path");
    }
    this.projectRoot = canonicalProjectRoot(projectRoot);
    this.administrationRoot = join(this.projectRoot, ".map/agent-collab-admin/learning");
    this.recordsRoot = join(this.administrationRoot, "records");
    this.headPath = join(this.administrationRoot, "head.json");
    this.promotionJournalPath = join(this.administrationRoot, "promotion-journal.json");
    this.promotionDatabasePath = join(this.administrationRoot, "promotion.db");
  }

  private withPromotionMutex<T>(action: () => T): T {
    ensureContainedLearningDirectories(this.projectRoot);
    const promotionDatabaseIdentity = preparePromotionDatabase(
      this.promotionDatabasePath,
      this.administrationRoot,
    );
    const promotionDatabase = new Database(this.promotionDatabasePath);
    try {
      requireUnchangedPromotionDatabase(this.promotionDatabasePath, promotionDatabaseIdentity);
      promotionDatabase.pragma("journal_mode = DELETE");
      promotionDatabase.pragma("synchronous = FULL");
      promotionDatabase.pragma("busy_timeout = 15000");
      promotionDatabase.exec(`CREATE TABLE IF NOT EXISTS promotion_mutex (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version TEXT NOT NULL CHECK (schema_version = 'map-learning-promotion/v1')
      ); INSERT OR IGNORE INTO promotion_mutex(singleton,schema_version)
        VALUES (1,'map-learning-promotion/v1');`);
      return promotionDatabase.transaction(() => {
        rollbackPromotionJournal(
          this.administrationRoot,
          this.recordsRoot,
          this.headPath,
          this.promotionJournalPath,
        );
        return action();
      }).immediate();
    } finally {
      promotionDatabase.close();
      requireUnchangedPromotionDatabase(this.promotionDatabasePath, promotionDatabaseIdentity);
    }
  }

  close(input: MapLearningCloseInput): MapLearningRecord {
    const parsedInput = MapLearningCloseInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(`invalid MAP learning close input schema: ${parsedInput.error.message}`);
    }
    const handoff = parseHandoff(parsedInput.data.handoffBytes);
    const candidate = parseCandidate(parsedInput.data.candidate);
    if (!this.authority) throw new Error("MAP learning close requires authoritative runtime review and evidence state");
    const taskPacketSha256 = sha256(parsedInput.data.taskPacketBytes);
    if (handoff.taskPacketSha256 !== taskPacketSha256) {
      throw new Error("stale learning provenance: task packet digest mismatch");
    }
    if (handoff.mapManifestSha256 !== parsedInput.data.mapManifestSha256) {
      throw new Error("stale learning provenance: MAP manifest digest mismatch");
    }
    if (handoff.mapVersion !== parsedInput.data.mapVersion) {
      throw new Error("stale learning provenance: MAP version mismatch");
    }

    const handoffSha256 = sha256(parsedInput.data.handoffBytes);
    const candidateSha256 = sha256(candidateBytes(candidate));
    if (handoff.candidateSha256 !== candidateSha256) {
      throw new Error("stale learning provenance: candidate digest mismatch");
    }
    if (redactSensitive(candidate.rule) !== candidate.rule) {
      throw new Error("MAP learning rule contains credential material");
    }
    const approvedControls = new Set<string>(APPROVED_LEARNING_CONTROL_IDS);
    if (candidate.controlIds.some((controlId) => !approvedControls.has(controlId))) {
      throw new Error("MAP learning candidate references an unknown canonical control");
    }
    const revalidatePromotion = (): void => {
      this.revalidateProfile?.();
      verifyLearningProvenance({
        projectRoot: this.projectRoot,
        taskPacketBytes: parsedInput.data.taskPacketBytes,
        handoff,
        candidate,
        authority: this.authority!,
      });
    };
    revalidatePromotion();
    const recordId = recordAddress(handoffSha256, candidateSha256);
    const record = MapLearningRecordSchema.parse({
      schemaVersion: "map-learning-record/v2",
      recordId,
      taskPacketSha256: handoff.taskPacketSha256,
      handoffSha256,
      candidateSha256,
      mapVersion: handoff.mapVersion,
      mapManifestSha256: handoff.mapManifestSha256,
      findingIds: [...handoff.findingIds].sort(),
      rule: candidate.rule,
      controlIds: candidate.controlIds,
      consumerScopes: candidate.consumerScopes,
      revision: candidate.revision,
    });

    return this.withPromotionMutex(() => {
        const head = readHead(this.headPath);
        this.authority?.promotionCheckpoint?.("before_publish");
        revalidatePromotion();
        if (head !== null) {
          const current = validateStoredRecord(join(this.recordsRoot, `${head.recordId}.json`));
          if (
            current.revision !== head.revision ||
            current.mapVersion !== head.mapVersion ||
            current.mapManifestSha256 !== head.mapManifestSha256
          ) {
            throw new Error("MAP learning head does not match its content-addressed record");
          }
          if (
            head.mapVersion !== record.mapVersion ||
            head.mapManifestSha256 !== record.mapManifestSha256
          ) {
            throw new Error("MAP learning head belongs to a stale installed profile");
          }
          if (record.revision === head.revision) {
            if (record.recordId !== head.recordId) {
              throw new Error("MAP learning revision CAS conflict");
            }
            return current;
          }
          if (record.revision !== head.revision + 1) {
            throw new Error("MAP learning revision must advance the promoted head by exactly one");
          }
        } else if (record.revision !== 1) {
          throw new Error("first MAP learning promotion must use revision 1");
        }

        const recordPath = join(this.recordsRoot, `${record.recordId}.json`);
        const recordExisted = existsSync(recordPath);
        writePromotionJournalAtomic(this.administrationRoot, this.promotionJournalPath, {
          schemaVersion: "map-learning-promotion-journal/v1",
          phase: "prepared",
          previousHead: head,
          recordId: record.recordId,
          recordExisted,
        });
        try {
          const published = publishExclusive(this.recordsRoot, record);
          writeHeadAtomic(this.administrationRoot, this.headPath, {
            schemaVersion: "map-learning-head/v1",
            revision: published.revision,
            recordId: published.recordId,
            mapVersion: published.mapVersion,
            mapManifestSha256: published.mapManifestSha256,
          });
          writePromotionJournalAtomic(this.administrationRoot, this.promotionJournalPath, {
            schemaVersion: "map-learning-promotion-journal/v1",
            phase: "published",
            previousHead: head,
            recordId: record.recordId,
            recordExisted,
          });
          this.authority?.promotionCheckpoint?.("after_publish");
          revalidatePromotion();
          removePromotionJournal(this.administrationRoot, this.promotionJournalPath);
          return published;
        } catch (error) {
          rollbackPromotionJournal(
            this.administrationRoot,
            this.recordsRoot,
            this.headPath,
            this.promotionJournalPath,
          );
          throw error;
        }
      });
  }

  projection(provider: LearningConsumer, profileInput: MapLearningProfile): MapLearningProjection {
    ConsumerScopeSchema.parse(provider);
    const profile = MapLearningProfileSchema.parse(profileInput);
    return this.withPromotionMutex(() => {
    const entries = readdirSync(this.recordsRoot);
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error("MAP learning registry exceeds the allowed entry count");
    }
    const recordNames = entries.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (recordNames.length > MAX_RECORDS) {
      throw new Error("MAP learning registry exceeds the allowed record count");
    }
    const head = readHead(this.headPath);
    const records = head === null
      ? []
      : [validateStoredRecord(join(this.recordsRoot, `${head.recordId}.json`))];
    if (head !== null && (
      head.mapVersion !== profile.mapVersion ||
      head.mapManifestSha256 !== profile.mapManifestSha256 ||
      records[0]?.revision !== head.revision ||
      records[0]?.mapVersion !== head.mapVersion ||
      records[0]?.mapManifestSha256 !== head.mapManifestSha256
    )) {
      throw new Error("MAP learning projection head does not match the current installed profile");
    }
    const bytes = jsonBytes({
      schemaVersion: "map-learning-projection/v1",
      records: records.filter(({ consumerScopes }) => new Set<string>(consumerScopes).has(provider)),
    });
    return { bytes, digest: sha256(bytes) };
    });
  }
}

/** @internal */
export interface MapLearningAdministrationConfig {
  controlRoot: string;
  databasePath: string;
  controlFingerprint?: () => string;
  promotionCheckpoint?: (phase: "before_publish" | "after_publish") => void;
}

/**
 * A configured administration boundary. The control root and durable database
 * are pinned once, so callers cannot redirect an individual mutation.
 */
/** @internal */
export class MapLearningAdministration {
  private readonly registry: MapLearningRegistry;

  constructor(config: MapLearningAdministrationConfig) {
    this.registry = new MapLearningRegistry(config.controlRoot, {
      databasePath: config.databasePath,
      ...(config.controlFingerprint ? { controlFingerprint: config.controlFingerprint } : {}),
      ...(config.promotionCheckpoint ? { promotionCheckpoint: config.promotionCheckpoint } : {}),
    });
  }

  get recordsRoot(): string {
    return this.registry.recordsRoot;
  }

  close(input: MapLearningCloseInput): MapLearningRecord {
    return this.registry.close(input);
  }

  projection(
    consumer: LearningConsumer,
    profile: MapLearningProfile,
  ): MapLearningProjection {
    return this.registry.projection(consumer, profile);
  }
}
