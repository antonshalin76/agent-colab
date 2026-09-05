import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson } from "../domain/canonical-json.js";
import { StateFileDurability } from "../store/state-file-durability.js";
import { openExistingStateLayout } from "../store/state-layout.js";
import {
  consumeVerifiedReviewedV4Promotion,
  requireReviewedV4SourceAcceptance,
  verifyEmbeddedReviewedV4Promotion,
  type ReviewedV4PromotionEvidence,
  type ReviewedV4PromotionTrust,
  type ReviewedV4SourceAcceptanceResult,
  type VerifiedReviewedV4Promotion,
} from "./reviewed-v4-source-acceptance.js";
import { reviewedV4MigrationAuthorityArtifactPaths } from "./reviewed-v4-migration-authority.js";
import { StateV4RestoreGuard } from "./operational-restore.js";
import { readActiveStateV4GuardDescriptor } from "./state-v4-restore-authority.js";
import {
  assertAuthenticReviewedV4BoundaryVerification,
  assertAuthenticReviewedV4RecoveryVerification,
  type ReviewedV4BoundaryVerification,
  type ReviewedV4RecoveryVerification,
} from "./reviewed-v4-bootstrap.js";
import {
  legacyTableManifestSha256,
  observeLegacyDatabase,
} from "./state-v4-manifest.js";
import {
  parseReviewedV4RecoveryRecord as parseRecovery,
  reviewedV4RecoveryRecordNames,
  reviewedV4RecoveryDraftSchema as recoveryDraftSchema,
  reviewedV4RecoverySchema as recoverySchema,
  type ReviewedV4RecoveryRecord as RecoveryRecord,
} from "./reviewed-v4-recovery-records.js";

const SHA256 = /^[a-f0-9]{64}$/;
const RECOVERY_DIRECTORY = "migration-v4/source-acceptance/recoveries";
const MAX_RECOVERY_DEPTH = 8;

export interface EffectiveReviewedV4SourceAcceptance {
  readonly receiptSha256: string;
  readonly authorityAcceptance: ReviewedV4SourceAcceptanceResult;
  readonly execution: ReviewedV4PromotionEvidence;
  readonly recovery?: Readonly<RecoveryRecord>;
}

export interface ReviewedV4RecoveryPublication {
  readonly status: "accepted";
  readonly created: boolean;
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly predecessorReceiptSha256: string;
  readonly authorityAdoptionSha256: string;
  readonly promotionSha256: string;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const recoveryPath = (digest: string): string => `${RECOVERY_DIRECTORY}/${digest}.json`;

const readRecovery = (stateRoot: string, digest: string): RecoveryRecord | undefined => {
  const path = resolve(stateRoot, recoveryPath(digest));
  if (!existsSync(path)) return undefined;
  const durability = new StateFileDurability({ stateRoot });
  try {
    const pinned = durability.openPinned(recoveryPath(digest));
    try { return parseRecovery(pinned.read(), digest); }
    finally { pinned.close(); }
  } finally { durability.close(); }
};

const recoveryRecords = (stateRoot: string): RecoveryRecord[] => {
  const directory = resolve(stateRoot, RECOVERY_DIRECTORY);
  if (!existsSync(directory)) return [];
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error("reviewed v4 recovery evidence directory is invalid");
  }
  const names = reviewedV4RecoveryRecordNames(readdirSync(directory));
  return names.sort().map((name) => readRecovery(stateRoot, name.slice(0, -5))!);
};

const assertBoundaryStillCompatible = (
  stateRoot: string,
  record: RecoveryRecord,
  authority: ReviewedV4SourceAcceptanceResult,
): void => {
  const layout = openExistingStateLayout(stateRoot);
  const state = observeLegacyDatabase(layout.database, "state", record.legacyStateManifest);
  const history = observeLegacyDatabase(layout.historyDatabase, "history");
  if (state.userVersion !== 4 || state.manifestSha256 !== record.boundary.state.manifestSha256 ||
      history.userVersion !== 2 || history.bytesSha256 !== record.boundary.history.bytesSha256 ||
      history.manifestSha256 !== record.boundary.history.manifestSha256) {
    throw new Error("reviewed v4 recovery acceptance target state changed");
  }
  if (legacyTableManifestSha256(record.legacyStateManifest) !== authority.target.state.manifestSha256) {
    throw new Error("reviewed v4 recovery acceptance changed the adopted legacy manifest");
  }
  const authorityPath = resolve(stateRoot,
    reviewedV4MigrationAuthorityArtifactPaths("stg04-production-close").authorization);
  const durability = new StateFileDurability({ stateRoot });
  try {
    const authority = durability.openPinned(
      reviewedV4MigrationAuthorityArtifactPaths("stg04-production-close").authorization,
    );
    try {
      if (authority.absolutePath !== authorityPath ||
          sha256(authority.read()) !== record.migrationAuthorizationSha256) {
        throw new Error("reviewed v4 recovery migration authorization changed");
      }
    } finally { authority.close(); }
  } finally { durability.close(); }
  const descriptor = readActiveStateV4GuardDescriptor(stateRoot);
  if (!descriptor || descriptor.descriptorSha256 !== record.restoreDescriptorSha256) {
    throw new Error("reviewed v4 recovery authority generation changed");
  }
  const completionPath = resolve(stateRoot,
    reviewedV4MigrationAuthorityArtifactPaths("stg04-production-close").completion);
  if (!existsSync(completionPath)) {
    if (state.bytesSha256 !== record.boundary.state.bytesSha256) {
      throw new Error("reviewed v4 recovery boundary bytes changed before completion");
    }
    const guard = new StateV4RestoreGuard({
      journalPath: descriptor.guardPath,
      databaseIdentity: descriptor.databaseIdentity,
      backupSha256: descriptor.backupSha256,
      tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
      writeEpoch: descriptor.writeEpoch,
    });
    const records = guard.readAndVerify();
    if (records.length !== 1 || records[0]?.event !== "backup_created") {
      throw new Error("reviewed v4 recovery guard changed before migration completion");
    }
  }
};

function resolveEffective(
  input: {
    readonly stateRoot: string;
    readonly receiptSha256: string;
    readonly trust: ReviewedV4PromotionTrust;
    readonly requireCurrentSource: boolean;
  },
  visited: Set<string>,
): EffectiveReviewedV4SourceAcceptance {
  if (!SHA256.test(input.receiptSha256) || visited.size >= MAX_RECOVERY_DEPTH || visited.has(input.receiptSha256)) {
    throw new Error("reviewed v4 source recovery chain is invalid, cyclic, or too deep");
  }
  const recovery = readRecovery(input.stateRoot, input.receiptSha256);
  if (!recovery) {
    const authorityAcceptance = requireReviewedV4SourceAcceptance({
      stateRoot: input.stateRoot,
      adoptionSha256: input.receiptSha256,
      trust: input.trust,
    });
    return Object.freeze({
      receiptSha256: authorityAcceptance.receiptSha256,
      authorityAcceptance,
      execution: Object.freeze({
        document: Object.freeze({}),
        promotionSha256: authorityAcceptance.promotionSha256,
        sourceIdentity: authorityAcceptance.sourceIdentity,
        planIdentity: authorityAcceptance.planIdentity,
        remote: authorityAcceptance.remote,
      }),
    });
  }
  const siblings = recoveryRecords(input.stateRoot)
    .filter((candidate) => candidate.predecessorReceiptSha256 === recovery.predecessorReceiptSha256);
  if (siblings.length !== 1 || siblings[0]?.recoverySha256 !== recovery.recoverySha256) {
    throw new Error("reviewed v4 recovery generation fork requires reconciliation");
  }
  visited.add(input.receiptSha256);
  const predecessor = resolveEffective({ ...input, receiptSha256: recovery.predecessorReceiptSha256,
    requireCurrentSource: false }, visited);
  visited.delete(input.receiptSha256);
  if (recovery.authorityAdoptionSha256 !== predecessor.authorityAcceptance.receiptSha256) {
    throw new Error("reviewed v4 recovery acceptance changed migration authority ownership");
  }
  const execution = verifyEmbeddedReviewedV4Promotion({
    document: recovery.promotion,
    trust: input.trust,
    observedAt: Date.parse(recovery.acceptedAt),
    requireCurrentSource: input.requireCurrentSource,
  });
  if (execution.promotionSha256 !== recovery.promotionSha256 ||
      canonicalJson(execution.planIdentity) !== canonicalJson(predecessor.authorityAcceptance.planIdentity)) {
    throw new Error("reviewed v4 recovery promotion is outside the original plan binding");
  }
  assertBoundaryStillCompatible(input.stateRoot, recovery, predecessor.authorityAcceptance);
  return Object.freeze({
    receiptSha256: recovery.recoverySha256,
    authorityAcceptance: predecessor.authorityAcceptance,
    execution,
    recovery: Object.freeze(structuredClone(recovery)),
  });
}

export function resolveEffectiveReviewedV4SourceAcceptance(input: {
  readonly stateRoot: string;
  readonly receiptSha256: string;
  readonly trust: ReviewedV4PromotionTrust;
  readonly requireCurrentSource?: boolean;
}): EffectiveReviewedV4SourceAcceptance {
  return resolveEffective({ ...input, requireCurrentSource: input.requireCurrentSource !== false }, new Set());
}

const existingMatchingRecovery = (input: {
  stateRoot: string;
  predecessorReceiptSha256: string;
  promotionSha256: string;
}): RecoveryRecord | undefined => {
  const successors = recoveryRecords(input.stateRoot)
    .filter((record) => record.predecessorReceiptSha256 === input.predecessorReceiptSha256);
  if (successors.length > 1 ||
      (successors.length === 1 && successors[0]!.promotionSha256 !== input.promotionSha256)) {
    throw new Error("reviewed v4 recovery generation fork requires reconciliation");
  }
  return successors[0];
};

export function publishReviewedV4RecoverySourceAcceptance(input: {
  readonly stateRoot: string;
  readonly predecessor: EffectiveReviewedV4SourceAcceptance;
  readonly verifiedPromotion: VerifiedReviewedV4Promotion;
  readonly trust: ReviewedV4PromotionTrust;
  readonly boundaryVerification: ReviewedV4BoundaryVerification;
  readonly recoveryVerification: ReviewedV4RecoveryVerification;
  readonly acceptedAt?: number;
}): ReviewedV4RecoveryPublication {
  assertAuthenticReviewedV4BoundaryVerification(input.boundaryVerification);
  assertAuthenticReviewedV4RecoveryVerification(input.recoveryVerification);
  const layout = openExistingStateLayout(input.stateRoot);
  if (input.boundaryVerification.phase !== "migration_boundary" ||
      input.boundaryVerification.stateDatabase !== layout.database) {
    throw new Error("reviewed v4 recovery requires an authentic migration-boundary verification");
  }
  const descriptor = readActiveStateV4GuardDescriptor(layout.root);
  if (!descriptor || descriptor.descriptorSha256 !== input.recoveryVerification.descriptorSha256) {
    throw new Error("reviewed v4 recovery authority capability is not current");
  }
  const authorityRelative = reviewedV4MigrationAuthorityArtifactPaths(
    "stg04-production-close",
  ).authorization;
  let migrationAuthorizationSha256: string;
  const authorityDurability = new StateFileDurability({ stateRoot: layout.root });
  try {
    const authority = authorityDurability.openPinned(authorityRelative);
    try { migrationAuthorizationSha256 = sha256(authority.read()); }
    finally { authority.close(); }
  } finally { authorityDurability.close(); }
  const promotion = consumeVerifiedReviewedV4Promotion(input.verifiedPromotion);
  if (canonicalJson(promotion.planIdentity) !==
      canonicalJson(input.predecessor.authorityAcceptance.planIdentity)) {
    throw new Error("reviewed v4 recovery promotion changed the frozen plan binding");
  }
  if (promotion.promotionSha256 === input.predecessor.execution.promotionSha256) {
    throw new Error("reviewed v4 recovery requires a distinct reviewed source promotion generation");
  }
  const prior = existingMatchingRecovery({ stateRoot: input.stateRoot,
    predecessorReceiptSha256: input.predecessor.receiptSha256, promotionSha256: promotion.promotionSha256 });
  if (prior && (prior.migrationAuthorizationSha256 !== migrationAuthorizationSha256 ||
      prior.restoreDescriptorSha256 !== input.recoveryVerification.descriptorSha256 ||
      prior.authorityAdoptionSha256 !== input.predecessor.authorityAcceptance.receiptSha256 ||
      legacyTableManifestSha256(prior.legacyStateManifest) !==
        legacyTableManifestSha256(input.recoveryVerification.legacyStateManifest))) {
    throw new Error("reviewed v4 recovery generation conflicts with current authority evidence");
  }
  if (prior) return Object.freeze({
    status: "accepted", created: false, receiptPath: resolve(input.stateRoot, recoveryPath(prior.recoverySha256)),
    receiptSha256: prior.recoverySha256, predecessorReceiptSha256: prior.predecessorReceiptSha256,
    authorityAdoptionSha256: prior.authorityAdoptionSha256, promotionSha256: prior.promotionSha256,
  });
  const completionPath = resolve(layout.root,
    reviewedV4MigrationAuthorityArtifactPaths("stg04-production-close").completion);
  if (existsSync(completionPath)) {
    throw new Error("reviewed v4 recovery generation cannot be created after migration completion");
  }
  const state = observeLegacyDatabase(
    layout.database,
    "state",
    input.recoveryVerification.legacyStateManifest,
  );
  const history = observeLegacyDatabase(layout.historyDatabase, "history");
  if (state.userVersion !== 4 || history.userVersion !== 2) {
    throw new Error("reviewed v4 recovery acceptance requires the exact uncompleted v4 database pair");
  }
  const acceptedAt = new Date(input.acceptedAt ?? Date.now()).toISOString();
  verifyEmbeddedReviewedV4Promotion({
    document: promotion.document,
    trust: input.trust,
    observedAt: Date.parse(acceptedAt),
  });
  const draft = recoveryDraftSchema.parse({
    schemaVersion: "reviewed-v4-source-recovery/v1",
    operationId: "stg04-production-close",
    predecessorReceiptSha256: input.predecessor.receiptSha256,
    authorityAdoptionSha256: input.predecessor.authorityAcceptance.receiptSha256,
    migrationAuthorizationSha256,
    restoreDescriptorSha256: input.recoveryVerification.descriptorSha256,
    failureClass: "post_commit_boundary_verification",
    acceptedAt,
    promotionSha256: promotion.promotionSha256,
    promotion: promotion.document,
    legacyStateManifest: input.recoveryVerification.legacyStateManifest,
    boundary: {
      state: { userVersion: state.userVersion, bytesSha256: state.bytesSha256,
        manifestSha256: state.manifestSha256 },
      history: { userVersion: history.userVersion, bytesSha256: history.bytesSha256,
        manifestSha256: history.manifestSha256 },
      graphExecution: "disabled",
      importedProgressEvents: 3,
    },
  });
  const record = recoverySchema.parse({ ...draft, recoverySha256: sha256(canonicalJson(draft)) });
  const bytes = Buffer.from(`${canonicalJson(record)}\n`);
  const durability = new StateFileDurability({ stateRoot: input.stateRoot });
  try {
    const published = durability.publishImmutable({ relativePath: recoveryPath(record.recoverySha256), bytes });
    try {
      if (!published.file.read().equals(bytes)) throw new Error("reviewed v4 recovery acceptance publication raced");
      return Object.freeze({
        status: "accepted", created: published.created, receiptPath: published.file.absolutePath,
        receiptSha256: record.recoverySha256, predecessorReceiptSha256: record.predecessorReceiptSha256,
        authorityAdoptionSha256: record.authorityAdoptionSha256, promotionSha256: record.promotionSha256,
      });
    } finally { published.file.close(); }
  } finally { durability.close(); }
}

export function requireExistingReviewedV4RecoverySourceAcceptance(input: {
  readonly stateRoot: string;
  readonly predecessor: EffectiveReviewedV4SourceAcceptance;
  readonly verifiedPromotion: VerifiedReviewedV4Promotion;
}): ReviewedV4RecoveryPublication {
  const promotion = consumeVerifiedReviewedV4Promotion(input.verifiedPromotion);
  if (canonicalJson(promotion.planIdentity) !==
      canonicalJson(input.predecessor.authorityAcceptance.planIdentity)) {
    throw new Error("reviewed v4 recovery promotion changed the frozen plan binding");
  }
  const prior = existingMatchingRecovery({
    stateRoot: input.stateRoot,
    predecessorReceiptSha256: input.predecessor.receiptSha256,
    promotionSha256: promotion.promotionSha256,
  });
  if (!prior || prior.authorityAdoptionSha256 !==
      input.predecessor.authorityAcceptance.receiptSha256) {
    throw new Error("reviewed v4 recovery generation has no existing exact acceptance");
  }
  return Object.freeze({
    status: "accepted",
    created: false,
    receiptPath: resolve(input.stateRoot, recoveryPath(prior.recoverySha256)),
    receiptSha256: prior.recoverySha256,
    predecessorReceiptSha256: prior.predecessorReceiptSha256,
    authorityAdoptionSha256: prior.authorityAdoptionSha256,
    promotionSha256: prior.promotionSha256,
  });
}
