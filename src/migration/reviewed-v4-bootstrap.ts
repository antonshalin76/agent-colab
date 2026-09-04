import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import {
  REVIEWED_V4_COMMIT,
  REVIEWED_V4_LAST_EVENT_SHA256,
  REVIEWED_V4_TREE,
  verifyReviewedV4Source,
  type ReviewedV4SourceInput,
} from "../flow/reviewed-v4-source.js";
import type {
  MigrationAuthorityCapability,
  MigrationAuthorityConsumerPort,
  MigrationAuthorityBinding,
} from "./reviewed-v4-migration-authority.js";

const REVIEWED_PATHS = [
  "docs/hybrid-flow-v1-r2/IMPLEMENTATION_START.json",
  "docs/hybrid-flow-v1-r2/PLAN_LOCK.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000001-r2-stg-00-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000002-stg-01-pass.json",
  "docs/hybrid-flow-v1-r2/stage-close/pre-v4/000003-stg-02-pass.json",
  "docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql",
  "scripts/verify-implementation-progress.mjs",
  "src/migration/coordinator.ts",
] as const;

export interface ReviewedV4BootstrapInput {
  readonly operationId: string;
  readonly gitRoot: string;
  readonly reviewedWorktreeParent: string;
  readonly sourceIdentity: { readonly commitOid: string; readonly treeOid: string };
  readonly stateDatabase: string;
  readonly historyDatabase: string;
}

export interface ReviewedV4BootstrapReceipt {
  readonly status: "migrated" | "already_current";
  readonly sourceCommitOid: string;
  readonly sourceTreeOid: string;
  readonly importedProgressEvents: number;
  readonly lastProgressEventSha256: string;
  readonly backupPath: string;
  readonly guardPath: string;
  readonly graphExecution: "disabled";
}

interface ReviewedMigrationProcess {
  run(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>;
}

interface MigrationQuiescence {
  assertServiceInactive(input: { readonly stateDatabase: string; readonly historyDatabase: string }): void;
  assertNoOpenDatabaseFds(input: { readonly stateDatabase: string; readonly historyDatabase: string }): void;
  acquireExclusiveWriteFence(input: {
    readonly stateDatabase: string;
    readonly historyDatabase: string;
  }): { assertCurrent(): void; release(): void };
}

interface BoundDatabasePair {
  readonly root: string;
  readonly state: CanonicalStateDatabaseIdentity;
  readonly history: CanonicalStateDatabaseIdentity;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function bindDatabasePair(input: ReviewedV4BootstrapInput): BoundDatabasePair {
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

function assertDatabasePairCurrent(pair: BoundDatabasePair): void {
  assertCanonicalStateDatabaseIdentity(pair.state);
  assertCanonicalStateDatabaseIdentity(pair.history);
}

function assertHistoryUnchanged(pair: BoundDatabasePair, expected: LegacyDatabaseObservation): void {
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

function verifyRecoveryAuthority(input: {
  readonly pair: BoundDatabasePair;
  readonly receipt: Record<string, unknown>;
  readonly status: "migrated" | "already_current";
  readonly preState: LegacyDatabaseObservation;
}): { readonly backupPath: string; readonly guardPath: string } {
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
  if (records.length !== 1 || records[0]?.event !== "backup_created") {
    throw new Error("reviewed migration recovery guard is not pristine");
  }
  return { backupPath, guardPath };
}

function inspectReviewedWorktree(worktree: string): ReviewedV4SourceInput {
  const commitOid = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const treeOid = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const rows = execFileSync("git", ["-C", worktree, "ls-tree", "-r", "HEAD", "--", ...REVIEWED_PATHS], {
    encoding: "utf8",
  }).trim().split("\n");
  const inventory = new Map(rows.map((row) => {
    const match = row.match(/^\d+\s+blob\s+([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error(`reviewed v4 source tree inventory is malformed: ${row}`);
    return [match[2]!, match[1]!] as const;
  }));
  return {
    commitOid,
    treeOid,
    files: REVIEWED_PATHS.map((path) => ({
      path,
      blobOid: inventory.get(path) ?? "",
      bytes: execFileSync("git", ["-C", worktree, "show", `HEAD:${path}`]),
    })),
  };
}

function verifyMigratedDatabase(stateDatabase: string): void {
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
    if (progress.length !== 3 || progress.some((row, index) => row.sequence_no !== index + 1) ||
        progress[2]?.event_sha256 !== REVIEWED_V4_LAST_EVENT_SHA256) {
      throw new Error("reviewed migrator did not import exactly progress events 1..3");
    }
    for (const table of ["graph_flows", "runs", "collaboration_dispatch_outbox"] as const) {
      if (Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()) !== 0) {
        throw new Error(`reviewed migrator unexpectedly activated ${table}`);
      }
    }
  } finally {
    db.close();
  }
}

export function createReviewedV4Bootstrap(dependencies: {
  readonly process: ReviewedMigrationProcess;
  readonly quiescence: MigrationQuiescence;
  readonly migrationAuthority: MigrationAuthorityConsumerPort;
}): {
  bootstrapReviewedV4(
    input: ReviewedV4BootstrapInput,
    capability?: MigrationAuthorityCapability,
  ): Promise<ReviewedV4BootstrapReceipt>;
} {
  const bootstrapReviewedV4 = async (
    input: ReviewedV4BootstrapInput,
    capability?: MigrationAuthorityCapability,
  ): Promise<ReviewedV4BootstrapReceipt> => {
    if (input.sourceIdentity.commitOid !== REVIEWED_V4_COMMIT || input.sourceIdentity.treeOid !== REVIEWED_V4_TREE) {
      throw new Error("reviewed source commit/tree identity is not accepted");
    }

    const binding: MigrationAuthorityBinding = {
      operationId: input.operationId,
      consumer: "codex:/root:state-v4-reviewed-bootstrap",
      scope: "reviewed-state-v4-migration",
      sourceIdentity: { commitOid: REVIEWED_V4_COMMIT, treeOid: REVIEWED_V4_TREE },
      stateDatabase: input.stateDatabase,
      historyDatabase: input.historyDatabase,
    };
    const authorityClaim = dependencies.migrationAuthority.claim(capability, binding);

    let authorityCompleted = false;
    const worktree = resolve(input.reviewedWorktreeParent, `state-v4-${randomUUID()}`);
    let worktreeAdded = false;
    let fence: ReturnType<MigrationQuiescence["acquireExclusiveWriteFence"]> | undefined;
    try {
      const pair = bindDatabasePair(input);
      const databasePaths = { stateDatabase: pair.state.path, historyDatabase: pair.history.path };
      dependencies.quiescence.assertServiceInactive(databasePaths);
      dependencies.quiescence.assertNoOpenDatabaseFds(databasePaths);
      fence = dependencies.quiescence.acquireExclusiveWriteFence(databasePaths);
      fence.assertCurrent();
      assertDatabasePairCurrent(pair);
      authorityClaim.assertCurrent();
      const preState = authorityClaim.preState;
      const preHistory = authorityClaim.preHistory;
      const currentState = observeLegacyDatabase(pair.state.path, "state", preState.manifest);
      if ((preState.userVersion !== 3 && preState.userVersion !== 4) || preHistory.userVersion !== 2) {
        throw new Error(`unsupported reviewed migration database pair: state=${preState.userVersion}, history=${preHistory.userVersion}`);
      }
      let receipt: Record<string, unknown>;
      let status: "migrated" | "already_current";
      if (currentState.userVersion === 4) {
        receipt = authorityClaim.completedReceipt ?? { status: "already_current" };
        status = "already_current";
      } else {
        mkdirSync(input.reviewedWorktreeParent, { recursive: true, mode: 0o700 });
        execFileSync("git", ["-C", input.gitRoot, "worktree", "add", "--detach", worktree, REVIEWED_V4_COMMIT], { stdio: "ignore" });
        worktreeAdded = true;
        verifyReviewedV4Source(inspectReviewedWorktree(worktree));
        const result = await dependencies.process.run({
          executable: process.execPath,
          args: [join(worktree, "scripts/agent-collab-launcher.mjs"), "migrate-v4"],
          cwd: worktree,
          env: { AGENT_COLLAB_STATE_DIR: pair.root },
        });
        fence.assertCurrent();
        assertDatabasePairCurrent(pair);
        assertHistoryUnchanged(pair, preHistory);
        if (result.status !== 0) throw new Error(`reviewed migrator process status ${String(result.status)}: ${result.stderr || result.stdout}`);
        try { receipt = JSON.parse(result.stdout) as Record<string, unknown>; }
        catch { throw new Error("reviewed migrator process returned malformed JSON"); }
        if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt) ||
            (receipt.status !== "migrated" && receipt.status !== "already_current")) {
          throw new Error("reviewed migrator process returned an unsupported receipt");
        }
        status = receipt.status;
      }
      verifyMigratedDatabase(pair.state.path);
      const { backupPath, guardPath } = verifyRecoveryAuthority({
        pair,
        receipt,
        status,
        preState,
      });
      assertDatabasePairCurrent(pair);
      assertHistoryUnchanged(pair, preHistory);
      const output = Object.freeze({
        status,
        sourceCommitOid: REVIEWED_V4_COMMIT,
        sourceTreeOid: REVIEWED_V4_TREE,
        importedProgressEvents: 3,
        lastProgressEventSha256: REVIEWED_V4_LAST_EVENT_SHA256,
        backupPath,
        guardPath,
        graphExecution: "disabled",
      });
      authorityClaim.complete(authorityClaim.completedReceipt ?? output);
      authorityCompleted = true;
      return output;
    } finally {
      try {
        if (worktreeAdded) {
          execFileSync("git", ["-C", input.gitRoot, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
        }
      } finally {
        try { fence?.release(); }
        finally { if (!authorityCompleted) authorityClaim.abort(); }
      }
    }
  };

  return Object.freeze({ bootstrapReviewedV4 });
}
