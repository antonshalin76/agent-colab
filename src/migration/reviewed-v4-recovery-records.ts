import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "../domain/canonical-json.js";
import { legacyTableManifestSha256 } from "./state-v4-manifest.js";

const SHA256 = /^[a-f0-9]{64}$/;
const RECOVERY_RECORD = /^[a-f0-9]{64}\.json$/;
const RECOVERY_PUBLICATION_TEMP = /^\.([a-f0-9]{64})\.json\.([1-9][0-9]*)\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/;
const observationSchema = z.object({
  userVersion: z.number().int(),
  bytesSha256: z.string().regex(SHA256),
  manifestSha256: z.string().regex(SHA256),
}).strict();
const legacyManifestSchema = z.object({
  schemaVersion: z.literal("legacy-table-digest-manifest/v1"),
  tables: z.array(z.object({
    name: z.string().min(1),
    columns: z.array(z.string().min(1)),
    rowCount: z.number().int().nonnegative(),
    rowsSha256: z.string().regex(SHA256),
  }).strict()),
}).strict();
export const reviewedV4RecoveryDraftSchema = z.object({
  schemaVersion: z.literal("reviewed-v4-source-recovery/v1"),
  operationId: z.literal("stg04-production-close"),
  predecessorReceiptSha256: z.string().regex(SHA256),
  authorityAdoptionSha256: z.string().regex(SHA256),
  migrationAuthorizationSha256: z.string().regex(SHA256),
  restoreDescriptorSha256: z.string().regex(SHA256),
  failureClass: z.literal("post_commit_boundary_verification"),
  acceptedAt: z.string().datetime(),
  promotionSha256: z.string().regex(SHA256),
  promotion: z.record(z.string(), z.unknown()),
  legacyStateManifest: legacyManifestSchema,
  boundary: z.object({
    state: observationSchema,
    history: observationSchema,
    graphExecution: z.literal("disabled"),
    importedProgressEvents: z.literal(3),
  }).strict(),
}).strict();
export const reviewedV4RecoverySchema = reviewedV4RecoveryDraftSchema.extend({
  recoverySha256: z.string().regex(SHA256),
}).strict();

export type ReviewedV4RecoveryRecord = z.infer<typeof reviewedV4RecoverySchema>;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function reviewedV4RecoveryRecordNames(names: readonly string[]): string[] {
  const records: string[] = [];
  for (const name of names) {
    if (RECOVERY_RECORD.test(name)) {
      records.push(name);
      continue;
    }
    if (!RECOVERY_PUBLICATION_TEMP.test(name)) {
      throw new Error("reviewed v4 recovery evidence directory contains an unknown artifact");
    }
  }
  return records.sort();
}

export function parseReviewedV4RecoveryRecord(
  bytes: Buffer,
  expectedDigest?: string,
): ReviewedV4RecoveryRecord {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error("reviewed v4 recovery acceptance is malformed", { cause: error }); }
  const parsed = reviewedV4RecoverySchema.safeParse(raw);
  if (!parsed.success || !bytes.equals(Buffer.from(`${canonicalJson(raw)}\n`))) {
    throw new Error("reviewed v4 recovery acceptance is invalid or noncanonical");
  }
  const { recoverySha256, ...draft } = parsed.data;
  if (recoverySha256 !== sha256(canonicalJson(draft)) ||
      (expectedDigest !== undefined && recoverySha256 !== expectedDigest) ||
      legacyTableManifestSha256(parsed.data.legacyStateManifest) !==
        parsed.data.boundary.state.manifestSha256) {
    throw new Error("reviewed v4 recovery acceptance digest is invalid");
  }
  return parsed.data;
}
