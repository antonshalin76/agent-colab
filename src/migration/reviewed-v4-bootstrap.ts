import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson } from "../domain/canonical-json.js";
import {
  assertCanonicalStateDatabaseIdentity,
  canonicalStateDatabaseIdentity,
  type CanonicalStateDatabaseIdentity,
} from "../store/state-database-fence.js";
import { openExistingStateLayout } from "../store/state-layout.js";
import { StateV4RestoreGuard } from "./operational-restore.js";
import { assertGraphV4PersistenceSchema } from "./graph-v4-schema.js";
import { assertReviewV3SchemaSignature } from "./review-v3-schema.js";
import {
  legacyTableManifestSha256,
  observeLegacyDatabase,
  parseLegacyTableManifest,
  type LegacyDatabaseObservation,
} from "./state-v4-manifest.js";
import { readActiveStateV4GuardDescriptor } from "./state-v4-restore-authority.js";

const REVIEWED_V4_LAST_EVENT_SHA256 = "924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469";

export interface ReviewedV4BootstrapInput {
  readonly operationId: string;
  readonly gitRoot: string;
  readonly reviewedWorktreeParent: string;
  readonly sourceIdentity: { readonly commitOid: string; readonly treeOid: string };
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

export interface BoundDatabasePair {
  readonly root: string;
  readonly state: CanonicalStateDatabaseIdentity;
  readonly history: CanonicalStateDatabaseIdentity;
}

export interface ReviewedV4BoundaryVerification {
  readonly stateDatabase: string;
  readonly phase: "migration_boundary" | "current_state";
  readonly bytesSha256: string;
}

export interface ReviewedV4RecoveryVerification {
  readonly backupPath: string;
  readonly guardPath: string;
  readonly descriptorSha256: string;
  readonly legacyStateManifest: LegacyDatabaseObservation["manifest"];
  assertCurrent(): void;
}

const authenticBoundaryVerifications = new WeakSet<object>();
const authenticRecoveryVerifications = new WeakSet<object>();

const freezeLegacyManifest = (
  manifest: LegacyDatabaseObservation["manifest"],
): LegacyDatabaseObservation["manifest"] => {
  const copy = structuredClone(manifest);
  for (const table of copy.tables) {
    Object.freeze(table.columns);
    Object.freeze(table);
  }
  Object.freeze(copy.tables);
  return Object.freeze(copy);
};

export function assertAuthenticReviewedV4BoundaryVerification(
  verification: ReviewedV4BoundaryVerification,
): void {
  if (!authenticBoundaryVerifications.has(verification as object)) {
    throw new Error("reviewed v4 boundary verification capability is not authentic");
  }
  if (sha256(readFileSync(verification.stateDatabase)) !== verification.bytesSha256) {
    throw new Error("reviewed v4 boundary bytes changed after verification");
  }
}

export function assertAuthenticReviewedV4RecoveryVerification(
  verification: ReviewedV4RecoveryVerification,
): void {
  if (!authenticRecoveryVerifications.has(verification as object)) {
    throw new Error("reviewed v4 recovery verification capability is not authentic");
  }
  verification.assertCurrent();
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function bindDatabasePair(input: ReviewedV4BootstrapInput): BoundDatabasePair {
  const requestedRoot = dirname(resolve(input.stateDatabase));
  const layout = openExistingStateLayout(requestedRoot);
  if (input.stateDatabase !== layout.database || input.historyDatabase !== layout.historyDatabase) {
    throw new Error("migration database pair must use the canonical collaboration.db and history.db targets");
  }
  const state = canonicalStateDatabaseIdentity(input.stateDatabase);
  const history = canonicalStateDatabaseIdentity(input.historyDatabase);
  if (state.path === history.path || state.root !== history.root ||
      state.rootIdentity.dev !== history.rootIdentity.dev || state.rootIdentity.ino !== history.rootIdentity.ino) {
    throw new Error("migration state/history database pair must share one canonical root and remain distinct");
  }
  return { root: state.root, state, history };
}

export function assertDatabasePairCurrent(pair: BoundDatabasePair): void {
  assertCanonicalStateDatabaseIdentity(pair.state);
  assertCanonicalStateDatabaseIdentity(pair.history);
}

export function assertHistoryUnchanged(pair: BoundDatabasePair, expected: LegacyDatabaseObservation): void {
  const current = observeLegacyDatabase(pair.history.path, "history", expected.manifest);
  if (current.userVersion !== 2 || current.bytesSha256 !== expected.bytesSha256 ||
      current.manifestSha256 !== expected.manifestSha256) {
    throw new Error("history database changed from the exact pre-migration digest");
  }
}

const assertOwnedArtifact = (root: string, path: string, label: string): string => {
  const canonicalRoot = realpathSync(root);
  const target = resolve(path);
  const rel = relative(canonicalRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`reviewed migration ${label} path is outside its canonical authority root`);
  }
  if (!existsSync(target)) throw new Error(`reviewed migration ${label} artifact is missing`);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(target) !== target) {
    throw new Error(`reviewed migration ${label} must be one canonical regular artifact`);
  }
  return target;
};

export function verifyRecoveryAuthority(input: {
  readonly pair: BoundDatabasePair;
  readonly receipt: Record<string, unknown>;
  readonly status: "migrated" | "already_current";
  readonly preState: LegacyDatabaseObservation;
  readonly preHistory: LegacyDatabaseObservation;
  readonly phase: "migration_boundary" | "current_state";
}): ReviewedV4RecoveryVerification {
  const descriptor = readActiveStateV4GuardDescriptor(input.pair.root);
  if (!descriptor) throw new Error("reviewed migration has no active recovery authority descriptor");
  const backupRoot = resolve(input.pair.root, "migration-v4/backups");
  const guardRoot = resolve(input.pair.root, "migration-guard");
  const backupPath = assertOwnedArtifact(backupRoot, descriptor.backupPath, "backup");
  const manifestPath = assertOwnedArtifact(backupRoot, descriptor.tableDigestManifestPath, "manifest");
  const guardPath = assertOwnedArtifact(guardRoot, descriptor.guardPath, "guard");
  if (manifestPath !== `${backupPath}.manifest.json` ||
      guardPath !== resolve(guardRoot, `state-v4-${descriptor.backupSha256}.jsonl`)) {
    throw new Error("reviewed migration recovery artifact paths are not canonical");
  }
  if (input.status === "migrated" &&
      (input.receipt.backupPath !== descriptor.backupPath || input.receipt.guardPath !== descriptor.guardPath)) {
    throw new Error("reviewed migrator receipt does not match the active recovery authority");
  }
  if ((input.receipt.backupPath !== undefined && input.receipt.backupPath !== descriptor.backupPath) ||
      (input.receipt.guardPath !== undefined && input.receipt.guardPath !== descriptor.guardPath)) {
    throw new Error("reviewed migrator receipt contains conflicting recovery artifact paths");
  }
  const stateIdentity = input.pair.state.databaseIdentity;
  const databaseIdentity = sha256(canonicalJson({
    path: input.pair.state.path,
    device: stateIdentity.dev,
    inode: stateIdentity.ino,
  }));
  if (descriptor.databaseIdentity !== databaseIdentity || descriptor.writeEpoch !== sha256(canonicalJson({
    databaseIdentity,
    tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
  }))) {
    throw new Error("reviewed migration recovery authority is not bound to the state database identity");
  }
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${backupPath}${suffix}`)) ||
      sha256(readFileSync(backupPath)) !== descriptor.backupSha256) {
    throw new Error("reviewed migration backup bytes do not match the recovery authority");
  }
  const manifest = parseLegacyTableManifest(readFileSync(manifestPath, "utf8"));
  if (legacyTableManifestSha256(manifest) !== descriptor.tableDigestManifestSha256 ||
      descriptor.tableDigestManifestSha256 !== input.preState.manifestSha256) {
    throw new Error("reviewed migration manifest does not match the pre-migration state digest");
  }
  const backup = observeLegacyDatabase(backupPath, "state");
  if (backup.userVersion !== input.preState.userVersion ||
      backup.manifestSha256 !== descriptor.tableDigestManifestSha256) {
    throw new Error("reviewed migration backup is not the expected semantic state artifact");
  }
  const migrated = observeLegacyDatabase(input.pair.state.path, "state", manifest);
  if (migrated.manifestSha256 !== descriptor.tableDigestManifestSha256) {
    throw new Error("migrated state no longer preserves the recovery manifest");
  }
  const history = observeLegacyDatabase(input.pair.history.path, "history", input.preHistory.manifest);
  if (history.bytesSha256 !== input.preHistory.bytesSha256 ||
      history.manifestSha256 !== input.preHistory.manifestSha256) {
    throw new Error("reviewed migration history changed before recovery verification");
  }
  let records: ReturnType<StateV4RestoreGuard["readAndVerify"]>;
  try {
    records = new StateV4RestoreGuard({
      journalPath: guardPath,
      databaseIdentity: descriptor.databaseIdentity,
      backupSha256: descriptor.backupSha256,
      tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
      writeEpoch: descriptor.writeEpoch,
    }).readAndVerify();
  } catch (error) {
    throw new Error("reviewed migration recovery guard is invalid", { cause: error });
  }
  if (input.phase === "migration_boundary") {
    if (records.length !== 1 || records[0]?.event !== "backup_created") {
      throw new Error("reviewed migration recovery guard is not pristine at the migration boundary");
    }
  } else if (records[0]?.event !== "backup_created" ||
      records.some(({ event }) => event === "restore_consumed")) {
    throw new Error("reviewed migration recovery guard is not an active unconsumed generation");
  }
  const stateBytesSha256 = migrated.bytesSha256;
  const historyBytesSha256 = history.bytesSha256;
  const backupBytesSha256 = sha256(readFileSync(backupPath));
  const manifestBytesSha256 = sha256(readFileSync(manifestPath));
  const guardBytesSha256 = sha256(readFileSync(guardPath));
  const verification: ReviewedV4RecoveryVerification = Object.freeze({
    backupPath,
    guardPath,
    descriptorSha256: descriptor.descriptorSha256,
    legacyStateManifest: freezeLegacyManifest(input.preState.manifest),
    assertCurrent() {
      const active = readActiveStateV4GuardDescriptor(input.pair.root);
      if (!active || active.descriptorSha256 !== descriptor.descriptorSha256 ||
          sha256(readFileSync(input.pair.state.path)) !== stateBytesSha256 ||
          sha256(readFileSync(input.pair.history.path)) !== historyBytesSha256 ||
          sha256(readFileSync(backupPath)) !== backupBytesSha256 ||
          sha256(readFileSync(manifestPath)) !== manifestBytesSha256 ||
          sha256(readFileSync(guardPath)) !== guardBytesSha256) {
        throw new Error("reviewed v4 recovery verification capability is no longer current");
      }
    },
  });
  authenticRecoveryVerifications.add(verification);
  return verification;
}

const verifyMigratedDatabase = (
  stateDatabase: string,
  phase: "migration_boundary" | "current_state",
): ReviewedV4BoundaryVerification => {
  const db = new Database(stateDatabase, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    assertGraphV4PersistenceSchema(db);
    assertReviewV3SchemaSignature(db);
    if (String(db.pragma("integrity_check", { simple: true })) !== "ok" ||
        (db.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new Error("reviewed migrator produced an invalid SQLite database");
    }
    const progress = db.prepare(
      "SELECT sequence_no,event_sha256 FROM plan_progress_events ORDER BY sequence_no",
    ).all() as Array<{ sequence_no: number; event_sha256: string }>;
    if ((phase === "migration_boundary" ? progress.length !== 3 : progress.length < 3) ||
        progress.some((row, index) => row.sequence_no !== index + 1) ||
        progress[2]?.event_sha256 !== REVIEWED_V4_LAST_EVENT_SHA256) {
      throw new Error(phase === "migration_boundary"
        ? "reviewed migrator did not import exactly progress events 1..3"
        : "reviewed v4 state does not preserve the imported progress prefix");
    }
    if (Number(db.prepare("SELECT COUNT(*) FROM graph_flows").pluck().get()) !== 0) {
      throw new Error("reviewed migrator unexpectedly activated graph_flows");
    }
    const executableLegacyRuns = Number(db.prepare(`SELECT COUNT(*) FROM runs
      WHERE status IN ('queued','claimed') OR lease_token IS NOT NULL OR worker_id IS NOT NULL`).pluck().get());
    if (executableLegacyRuns !== 0) {
      throw new Error("reviewed migrator left executable or owned legacy runs");
    }
    const unpublishedLegacyDispatches = Number(db.prepare(`SELECT COUNT(*)
      FROM collaboration_dispatch_outbox WHERE published_at IS NULL`).pluck().get());
    if (unpublishedLegacyDispatches !== 0) {
      throw new Error("reviewed migrator left unpublished legacy dispatches");
    }
  } finally {
    db.close();
  }
  const verification = Object.freeze({
    stateDatabase,
    phase,
    bytesSha256: sha256(readFileSync(stateDatabase)),
  });
  authenticBoundaryVerifications.add(verification);
  return verification;
};

export const verifyMigratedDatabaseAtBoundary = (stateDatabase: string): ReviewedV4BoundaryVerification =>
  verifyMigratedDatabase(stateDatabase, "migration_boundary");

export const verifyCurrentReviewedV4Database = (stateDatabase: string): ReviewedV4BoundaryVerification =>
  verifyMigratedDatabase(stateDatabase, "current_state");

export function createReviewedV4Bootstrap(): never {
  throw new Error("child/worktree reviewed-v4 bootstrap is permanently disabled; use the in-process production transition");
}
