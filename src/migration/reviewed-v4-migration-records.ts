import { isAbsolute } from "node:path";
import { z } from "zod";

import { canonicalJson } from "../domain/canonical-json.js";

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const targetFileIdentitySchema = z.object({
  path: z.string().min(1).refine(isAbsolute),
  dev: safeInteger,
  ino: safeInteger,
}).strict();
const targetDatabaseIdentitySchema = targetFileIdentitySchema.extend({
  userVersion: z.number().int(),
  bytesSha256: z.string().regex(SHA256),
  manifestSha256: z.string().regex(SHA256),
}).strict();

export interface MigrationAuthorityBinding {
  readonly operationId: string;
  readonly consumer: "codex:/root:state-v4-reviewed-bootstrap";
  readonly scope: "reviewed-state-v4-migration";
  readonly adoptionSha256: string;
  readonly promotionSha256: string;
  readonly sourceIdentity: {
    readonly commitOid: string;
    readonly treeOid: string;
    readonly manifestSha256: string;
    readonly lastProgressEventSha256: string;
  };
  readonly targetIdentity: {
    readonly root: { readonly path: string; readonly dev: number; readonly ino: number };
    readonly state: {
      readonly path: string;
      readonly dev: number;
      readonly ino: number;
      readonly userVersion: number;
      readonly bytesSha256: string;
      readonly manifestSha256: string;
    };
    readonly history: {
      readonly path: string;
      readonly dev: number;
      readonly ino: number;
      readonly userVersion: number;
      readonly bytesSha256: string;
      readonly manifestSha256: string;
    };
  };
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

export interface DurableMigrationCompletion {
  readonly schemaVersion: "reviewed-v4-migration-completion/v2";
  readonly operationId: string;
  readonly binding: MigrationAuthorityBinding;
  readonly receipt: Readonly<Record<string, unknown>>;
}

export const migrationAuthorityBindingSchema = z.object({
  operationId: z.literal("stg04-production-close"),
  consumer: z.literal("codex:/root:state-v4-reviewed-bootstrap"),
  scope: z.literal("reviewed-state-v4-migration"),
  adoptionSha256: z.string().regex(SHA256),
  promotionSha256: z.string().regex(SHA256),
  sourceIdentity: z.object({
    commitOid: z.string().regex(SHA1),
    treeOid: z.string().regex(SHA1),
    manifestSha256: z.string().regex(SHA256),
    lastProgressEventSha256: z.string().regex(SHA256),
  }).strict(),
  targetIdentity: z.object({
    root: targetFileIdentitySchema,
    state: targetDatabaseIdentitySchema,
    history: targetDatabaseIdentitySchema,
  }).strict(),
  stateDatabase: z.string().min(1).refine(isAbsolute),
  historyDatabase: z.string().min(1).refine(isAbsolute),
}).strict();

export const exactMigrationAuthorityBinding = (
  left: MigrationAuthorityBinding,
  right: MigrationAuthorityBinding,
): boolean => canonicalJson(left) === canonicalJson(right);

export function parseReviewedV4MigrationCompletion(
  bytes: Buffer,
  expectedBinding?: MigrationAuthorityBinding,
): DurableMigrationCompletion {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("durable migration completion record is malformed", { cause: error }); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("durable migration completion record is not an object");
  }
  const completion = parsed as DurableMigrationCompletion;
  const binding = migrationAuthorityBindingSchema.safeParse(completion.binding);
  const keys = Object.keys(completion).sort();
  if (canonicalJson(keys) !== canonicalJson(["binding", "operationId", "receipt", "schemaVersion"].sort()) ||
      !bytes.equals(Buffer.from(`${canonicalJson(completion)}\n`)) ||
      completion.schemaVersion !== "reviewed-v4-migration-completion/v2" ||
      completion.operationId !== "stg04-production-close" || !binding.success ||
      completion.operationId !== completion.binding.operationId ||
      (expectedBinding !== undefined && !exactMigrationAuthorityBinding(completion.binding, expectedBinding)) ||
      completion.receipt === null || typeof completion.receipt !== "object" || Array.isArray(completion.receipt)) {
    throw new Error("durable migration completion record is noncanonical or conflicts with its exact operation");
  }
  const receiptKeys = Object.keys(completion.receipt).sort();
  if (canonicalJson(receiptKeys) !== canonicalJson([
    "backupPath", "graphExecution", "guardPath", "importedProgressEvents", "lastProgressEventSha256",
    "sourceCommitOid", "sourceTreeOid", "status",
  ].sort()) ||
      (completion.receipt.status !== "migrated" && completion.receipt.status !== "already_current") ||
      completion.receipt.sourceCommitOid !== completion.binding.sourceIdentity.commitOid ||
      completion.receipt.sourceTreeOid !== completion.binding.sourceIdentity.treeOid ||
      completion.receipt.importedProgressEvents !== 3 ||
      completion.receipt.lastProgressEventSha256 !== completion.binding.sourceIdentity.lastProgressEventSha256 ||
      completion.receipt.graphExecution !== "disabled" ||
      typeof completion.receipt.backupPath !== "string" || !isAbsolute(completion.receipt.backupPath) ||
      typeof completion.receipt.guardPath !== "string" || !isAbsolute(completion.receipt.guardPath)) {
    throw new Error("durable migration completion receipt does not match the reviewed v4 contract");
  }
  return completion;
}
