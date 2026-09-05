import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { canonicalJson } from "../domain/canonical-json.js";
import { StateFileDurability } from "../store/state-file-durability.js";
import { parseReviewedV4MigrationCompletion } from "./reviewed-v4-migration-records.js";
import {
  parseReviewedV4RecoveryRecord,
  reviewedV4RecoveryRecordNames,
  type ReviewedV4RecoveryRecord,
} from "./reviewed-v4-recovery-records.js";

const SHA256 = /^[a-f0-9]{64}$/;
const RECOVERY_DIRECTORY = "migration-v4/source-acceptance/recoveries";
const COMPLETION_DIRECTORY = "migration-v4/source-acceptance/recovery-completions";
const AUTHORITY_COMPLETION = "migration-v4/authority/stg04-production-close.completion.json";

const markerDraftSchema = z.object({
  schemaVersion: z.literal("reviewed-v4-recovery-completion/v1"),
  operationId: z.literal("stg04-production-close"),
  recoverySha256: z.string().regex(SHA256),
  recoveryChainSha256: z.array(z.string().regex(SHA256)).min(1),
  migrationCompletionSha256: z.string().regex(SHA256),
}).strict();
const markerSchema = markerDraftSchema.extend({
  markerSha256: z.string().regex(SHA256),
}).strict();

type RecoveryEnvelope = ReviewedV4RecoveryRecord;
type CompletionMarker = z.infer<typeof markerSchema>;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const recoveryPath = (digest: string): string => `${RECOVERY_DIRECTORY}/${digest}.json`;
const markerPath = (digest: string): string => `${COMPLETION_DIRECTORY}/${digest}.json`;

const parseRecoveryEnvelope = (bytes: Buffer, expectedDigest: string): RecoveryEnvelope => {
  return parseReviewedV4RecoveryRecord(bytes, expectedDigest);
};

const assertAuthorityCompletion = (
  bytes: Buffer,
  recovery: RecoveryEnvelope,
): void => {
  const completion = parseReviewedV4MigrationCompletion(bytes);
  if (completion.binding.adoptionSha256 !== recovery.authorityAdoptionSha256) {
    throw new Error("reviewed v4 recovery completion is outside its migration authority binding");
  }
};

const parseMarker = (
  bytes: Buffer,
  expectedRecoverySha256: string,
  expectedRecoveryChainSha256: readonly string[],
  expectedCompletionSha256: string,
): CompletionMarker => {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("reviewed v4 recovery completion marker is malformed", { cause: error }); }
  const parsed = markerSchema.safeParse(raw);
  if (!parsed.success || !bytes.equals(Buffer.from(`${canonicalJson(raw)}\n`))) {
    throw new Error("reviewed v4 recovery completion marker is invalid or noncanonical");
  }
  const { markerSha256, ...draft } = parsed.data;
  if (markerSha256 !== sha256(canonicalJson(draft)) ||
      parsed.data.recoverySha256 !== expectedRecoverySha256 ||
      canonicalJson(parsed.data.recoveryChainSha256) !== canonicalJson(expectedRecoveryChainSha256) ||
      parsed.data.migrationCompletionSha256 !== expectedCompletionSha256) {
    throw new Error("reviewed v4 recovery completion marker binding is invalid");
  }
  return parsed.data;
};

const readPinned = (durability: StateFileDurability, relativePath: string): Buffer => {
  const pinned = durability.openPinned(relativePath);
  try { return pinned.read(); }
  finally { pinned.close(); }
};

const recoveryNames = (stateRoot: string): string[] => {
  const directory = resolve(stateRoot, RECOVERY_DIRECTORY);
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error("reviewed v4 recovery evidence directory is invalid");
  }
  return reviewedV4RecoveryRecordNames(readdirSync(directory));
};

const readRecoveryChain = (
  durability: StateFileDurability,
  stateRoot: string,
  leafSha256?: string,
): { readonly chain: readonly RecoveryEnvelope[]; readonly leaf: RecoveryEnvelope } => {
  const records = recoveryNames(stateRoot).map((name) => {
    const digest = name.slice(0, -5);
    return parseRecoveryEnvelope(readPinned(durability, recoveryPath(digest)), digest);
  });
  if (records.length === 0) throw new Error("reviewed v4 recovery chain is absent");
  const byDigest = new Map(records.map((record) => [record.recoverySha256, record]));
  const predecessorDigests = new Set(records.map((record) => record.predecessorReceiptSha256));
  const leaves = records.filter((record) => !predecessorDigests.has(record.recoverySha256));
  const leaf = leafSha256 === undefined ? (leaves.length === 1 ? leaves[0] : undefined) : byDigest.get(leafSha256);
  if (!leaf || (leafSha256 !== undefined && !leaves.some(({ recoverySha256 }) => recoverySha256 === leafSha256))) {
    throw new Error("reviewed v4 recovery chain has no unique requested leaf");
  }
  const reverse: RecoveryEnvelope[] = [];
  const visited = new Set<string>();
  let current: RecoveryEnvelope | undefined = leaf;
  while (current) {
    if (visited.has(current.recoverySha256)) throw new Error("reviewed v4 recovery chain is cyclic");
    visited.add(current.recoverySha256);
    reverse.push(current);
    current = byDigest.get(current.predecessorReceiptSha256);
  }
  if (visited.size !== records.length ||
      reverse.some((record) => record.authorityAdoptionSha256 !== leaf.authorityAdoptionSha256)) {
    throw new Error("reviewed v4 recovery chain is forked, disconnected, or changes authority");
  }
  return Object.freeze({ chain: Object.freeze(reverse.reverse()), leaf });
};

export function publishReviewedV4RecoveryCompletionBarrier(input: {
  readonly stateRoot: string;
  readonly recoverySha256: string;
}): Readonly<CompletionMarker> {
  if (!SHA256.test(input.recoverySha256)) {
    throw new Error("reviewed v4 recovery completion digest is invalid");
  }
  const durability = new StateFileDurability({ stateRoot: input.stateRoot });
  try {
    const recoveryChain = readRecoveryChain(durability, input.stateRoot, input.recoverySha256);
    const recovery = recoveryChain.leaf;
    const completionBytes = readPinned(durability, AUTHORITY_COMPLETION);
    assertAuthorityCompletion(completionBytes, recovery);
    const draft = markerDraftSchema.parse({
      schemaVersion: "reviewed-v4-recovery-completion/v1",
      operationId: "stg04-production-close",
      recoverySha256: input.recoverySha256,
      recoveryChainSha256: recoveryChain.chain.map(({ recoverySha256 }) => recoverySha256),
      migrationCompletionSha256: sha256(completionBytes),
    });
    const marker = markerSchema.parse({ ...draft, markerSha256: sha256(canonicalJson(draft)) });
    const bytes = Buffer.from(`${canonicalJson(marker)}\n`);
    const published = durability.publishImmutable({ relativePath: markerPath(input.recoverySha256), bytes });
    try {
      if (!published.file.read().equals(bytes)) {
        throw new Error("reviewed v4 recovery completion marker publication raced");
      }
    } finally { published.file.close(); }
    return Object.freeze(marker);
  } finally { durability.close(); }
}

export function assertNoPendingReviewedV4SourceRecovery(stateRoot: string): void {
  const names = recoveryNames(stateRoot);
  if (names.length === 0) return;
  const durability = new StateFileDurability({ stateRoot });
  try {
    const completionBytes = readPinned(durability, AUTHORITY_COMPLETION);
    const completionSha256 = sha256(completionBytes);
    const recoveryChain = readRecoveryChain(durability, stateRoot);
    const recoverySha256 = recoveryChain.leaf.recoverySha256;
    assertAuthorityCompletion(completionBytes, recoveryChain.leaf);
    parseMarker(
      readPinned(durability, markerPath(recoverySha256)),
      recoverySha256,
      recoveryChain.chain.map(({ recoverySha256: digest }) => digest),
      completionSha256,
    );
  } catch (error) {
    throw new Error("reviewed v4 source recovery is pending valid migration completion", { cause: error });
  } finally { durability.close(); }
}
