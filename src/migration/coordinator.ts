import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { redactSensitive } from "../security/redaction.js";
import {
  acquireStateRootLease,
  ensureStateV4MigrationLayout,
  GRAPH_EXECUTION_MODE,
  type StateRootLease,
} from "../store/state-layout.js";
import {
  assertCanonicalStateDatabaseIdentity,
  canonicalStateDatabaseIdentity,
  openStateDatabaseLease,
  type CanonicalStateDatabaseIdentity,
} from "../store/state-database-fence.js";
import { canonicalJson } from "../workflow/flow-contract.js";
import {
  assertReviewV3SchemaSignature,
  extendReviewV3SchemaOffline,
  type ReviewV3FaultPoint,
} from "./review-v3-schema.js";
import {
  finalizeRollbackBundle,
  prepareRollbackBundle,
  restoreV1Bundle,
} from "./rollback-bundle.js";
import { StateV4RestoreGuard, type StateV4GuardFaultPoint } from "./operational-restore.js";
import {
  GRAPH_V4_REQUIRED_INDEXES,
  GRAPH_V4_TABLES,
  assertGraphV4PersistenceSchema,
  graphV4SchemaState as graphSchemaState,
} from "./graph-v4-schema.js";
import {
  activeStateV4GuardDescriptor,
  assertNoInterruptedRetirement,
  assertPhysicalRestoreAllowed,
  inspectStateV4OpenAdmission,
  readActiveStateV4GuardDescriptor,
  requireStateV4RestoreAuthority,
  retireConsumedStateV4Descriptor,
  retiredStateV4Descriptors,
  writeActiveStateV4GuardDescriptor,
} from "./state-v4-restore-authority.js";

export {
  prepareRollbackBundle,
  restoreV1Bundle,
  verifyBundle,
} from "./rollback-bundle.js";

const V1 = 1;
const V2 = 2;
const V3 = 3;
const V4 = 4;

const V4_LAUNCH_AUTHORITY_TRIGGERS = `
  CREATE TRIGGER runtime_review_attempt_v2_insert
  BEFORE INSERT ON runtime_review_lane_attempts
  WHEN (SELECT launch_authority_version FROM runtime_review_barriers
        WHERE review_id = NEW.review_id) = 2
  BEGIN
    SELECT CASE WHEN NEW.attempt_ordinal <> 0
      THEN RAISE(ABORT, 'launch authority v2 requires attempt_ordinal=0') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM runtime_review_lane_attempts
      WHERE review_id = NEW.review_id AND agent = NEW.agent AND role = NEW.role
    ) THEN RAISE(ABORT, 'launch authority v2 permits one lane attempt') END;
  END;
  CREATE TRIGGER runtime_review_attempt_v2_update
  BEFORE UPDATE ON runtime_review_lane_attempts
  WHEN (SELECT launch_authority_version FROM runtime_review_barriers
        WHERE review_id = NEW.review_id) = 2
  BEGIN
    SELECT CASE WHEN NEW.attempt_ordinal <> 0
      THEN RAISE(ABORT, 'launch authority v2 requires attempt_ordinal=0') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM runtime_review_lane_attempts
      WHERE review_id = NEW.review_id AND agent = NEW.agent AND role = NEW.role
        AND rowid <> OLD.rowid
    ) THEN RAISE(ABORT, 'launch authority v2 permits one lane attempt') END;
  END;
  CREATE TRIGGER runtime_review_barrier_v2_update
  BEFORE UPDATE OF launch_authority_version ON runtime_review_barriers
  WHEN NEW.launch_authority_version = 2 AND EXISTS (
    SELECT 1 FROM runtime_review_lane_attempts
    WHERE review_id = NEW.review_id
    GROUP BY agent, role
    HAVING COUNT(*) > 1 OR MIN(attempt_ordinal) <> 0 OR MAX(attempt_ordinal) <> 0
  )
  BEGIN
    SELECT RAISE(ABORT, 'launch authority v2 requires one ordinal-zero lane attempt');
  END;
`;

const V3_GUARDED_TABLES = [
  "runs",
  "collaboration_runs",
  "collaboration_dispatch_outbox",
  "runtime_review_barriers",
  "runtime_review_lanes",
  "runtime_review_lane_attempts",
  "worktree_leases",
] as const;

const MUTABLE_RUNTIME_TABLES = [
  "runs",
  "collaboration_runs",
  "collaboration_dispatch_outbox",
  "runtime_review_barriers",
  "runtime_review_lanes",
  "runtime_review_lane_attempts",
  "approval_grants",
  "approval_consumptions",
  "worktree_leases",
  "worktree_handoffs",
  "approval_grants",
  "approval_consumptions",
] as const;

const HISTORY_TABLES = {
  sources: ["project", "source_path", "agent", "checkpoint_offset", "checkpoint_line", "prefix_hash", "session_id"],
  history_rows: ["project", "source_path", "record_key", "source_agent", "kind", "session_id", "role", "content",
    "source_line", "timestamp", "content_hash", "trust"],
  pending_tools: ["project", "source_path", "call_id", "agent", "name", "session_id", "source_line", "timestamp", "record_key"],
  history_issues: ["project", "source_path", "code", "source_line", "details"],
} as const;

const historyNamespace = (agent: unknown): string => {
  if (agent === "grok") return "grok_native";
  if (agent === "codex") return "codex_native";
  if (agent === "claude" || agent === "claude_legacy") return "claude_legacy";
  throw new Error(`unsupported history source agent: ${String(agent)}`);
};

export type MigrationFaultPoint =
  | "after_state_commit"
  | "after_history_commit"
  | "before_v3_commit"
  | "after_v4_backup"
  | "before_v4_descriptor"
  | "after_v4_orphan_adoption"
  | "after_v4_guard"
  | "before_v4_terminal_artifact_reread"
  | "after_v4_progress_verify"
  | "after_v4_ddl"
  | "during_v4_progress_import"
  | "before_v4_commit"
  | "after_v4_restore_staged"
  | "after_v4_restore_consumed"
  | "after_v4_restore_renamed"
  | "after_v4_restore_root_fsync"
  | "after_v4_retired_descriptor_rename"
  | "after_v4_retired_directory_fsync"
  | "after_v4_active_descriptor_removed"
  | "after_v4_active_descriptor_directory_fsync"
  | "after_v4_retirement_marker_removed"
  | "after_v4_retirement_marker_directory_fsync"
  | StateV4GuardFaultPoint
  | ReviewV3FaultPoint;

export interface MigrationCoordinatorOptions {
  stateDatabase: string;
  historyDatabase: string;
  faultInjector?: (point: MigrationFaultPoint) => void;
  backupDirectory?: string;
  repositoryRoot?: string;
  progressPackagePath?: string;
}

export interface V4MigrationReceipt {
  status: "migrated";
  fromVersion: 3 | 4;
  toVersion: 4;
  backupPath: string;
  backupSha256: string;
  guardPath: string;
  databaseIdentity: string;
  tableDigestManifestSha256: string;
  tableDigestManifestPath: string;
  writeEpoch: string;
  importedProgressEvents: number;
  lastProgressEventSha256: string;
}

export type MigrationResult =
  | { status: "migrated"; fromVersion: 1; toVersion: 2; rollbackBundle: string }
  | { status: "already_current"; fromVersion: 2; toVersion: 2 }
  | { status: "migrated"; fromVersion: 2; toVersion: 3 }
  | { status: "already_current"; fromVersion: 3; toVersion: 3 }
  | V4MigrationReceipt
  | { status: "already_current"; fromVersion: 4; toVersion: 4 };

export interface V1DoctorResult {
  readyForMigration: boolean;
  stateVersion: number;
  historyVersion: number;
  blockers: string[];
  mutableCounts: Record<string, number>;
}

export class MigrationBlockedError extends Error {
  readonly code = "MUTABLE_RUNTIME_NOT_EMPTY";

  constructor(readonly blockingTables: string[]) {
    super(`offline migration requires empty mutable runtime tables: ${blockingTables.join(", ")}`);
    this.name = "MigrationBlockedError";
  }
}

interface TableDigest {
  count: number;
  sha256: string;
}

export interface CompatibilityRuntimeObservation {
  schemaVersion: "compatibility-runtime-open-observation/v1";
  stateVersion: 3 | 4;
  historyVersion: 2;
  openMode: "read_only";
  graphExecution: "disabled";
  graphSchema: "absent" | "complete_disabled";
  reviewSchema: "routing_v5" | "review_v3";
  stateProfile: "v3_routing_v5" | "v4_routing_v5" | "v4_review_v3";
  stateSchemaSha256: string;
  historySchemaSha256: string;
  integrity: { state: "ok"; history: "ok"; foreignKeys: "ok" };
}

const GRAPH_V4_DDL_SHA256 = "43ae43d139ac44f25d2132439600a5405c1082a8278aca60cffeab5e479ead8b";
const LEGACY_STATE_PROFILE_SHA256 = {
  v3_routing_v5: [
    "7a29baaff38b71f25e6670429398944b34b708f9f661ea4512eddacfa2b5d585",
    "3ca282d1e539a2b6c1928b91eb00bb0f3623b023d31eb0853386aa486f20d009",
  ],
  v4_routing_v5: ["d9843b1c811c1fddfe916b51fb6c0e90f18d4c53185f78fc2b068c2862b69bb0"],
  v4_review_v3: ["761f81590bfb897a81be8fc42ae2b133d11cfe45d96d031460fc392645938ed3"],
} as const;
const HISTORY_V2_SCHEMA_SHA256 = [
  "58b2d0fd246bbe2ee62969dded0f2a6dcd242340ae90f6a9293abed4c2dbe2fd",
  "f4ef7b73fa2cf1dc8b9678ef0062122b74598feb2db2c46bc463c19dacbb611d",
] as const;

const EXECUTION_TABLES = [
  "runs",
  "collaboration_runs",
  "collaboration_dispatch_outbox",
  "runtime_provider_health",
  "runtime_review_barriers",
  "runtime_review_lanes",
  "runtime_review_lane_attempts",
  "worktree_leases",
  "worktree_handoffs",
] as const;

const V3_LEGACY_TABLES = new Set([
  "approval_consumptions", "approval_grants", "collaboration_dispatch_outbox",
  "collaboration_runs", "runs", "runtime_provider_health", "runtime_review_barriers",
  "runtime_review_lane_attempts", "runtime_review_lanes", "worktree_handoffs", "worktree_leases",
]);
const V3_FLOW_EVIDENCE_TABLES = new Set([
  "flow_evidence_executions_v9", "flow_evidence_receipts_v9", "flow_evidence_requests_v9",
]);

const assertKnownV3LegacyObjects = (db: Database.Database): void => {
  const rows = normalizedSchemaRows(db).filter((row) => row.type === "table" || row.type === "trigger" || row.type === "view");
  const unexpectedKinds = rows.filter((row) => row.type !== "table");
  if (unexpectedKinds.length > 0) throw new Error("unexpected trigger or view in v3 legacy schema");
  const tables = new Set(rows.map(({ name }) => name));
  const missing = [...V3_LEGACY_TABLES].filter((name) => !tables.has(name));
  const extras = [...tables].filter((name) => !V3_LEGACY_TABLES.has(name));
  const exactEvidenceSet = extras.length === V3_FLOW_EVIDENCE_TABLES.size &&
    extras.every((name) => V3_FLOW_EVIDENCE_TABLES.has(name));
  if (missing.length > 0 || (extras.length > 0 && !exactEvidenceSet)) {
    throw new Error(`unknown or incomplete v3 legacy object set: missing=${missing.join(",")}; extra=${extras.join(",")}`);
  }
};

export function initializeCurrentExecutionSchemaDatabase(
  db: Database.Database,
  options: { faultInjector?: (point: string) => void } = {},
): void {
  db.pragma("foreign_keys = ON");
  {
    const existing = EXECUTION_TABLES.filter((table) => tableExists(db, table));
    if (existing.length === EXECUTION_TABLES.length) {
      if (userVersion(db) === V4 && graphSchemaState(db) !== "complete_disabled") {
        throw new Error("state v4 graph schema is absent; stopped-service migrate-v4 is required");
      }
      if (tableExists(db, "runtime_schema_capabilities")) {
        assertReviewV3SchemaSignature(db);
      } else {
        extendReviewV3SchemaOffline(db, options.faultInjector);
      }
      return;
    }
    if (existing.length > 0) {
      throw new Error(`execution schema is partial; offline repair required: ${existing.join(", ")}`);
    }
    const initialize = db.transaction(() => {
      db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
        priority INTEGER NOT NULL, status TEXT NOT NULL, artifact_hash TEXT, approval_scope TEXT,
        created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
        lease_token TEXT, lease_expires_at INTEGER, worker_id TEXT, launched INTEGER NOT NULL DEFAULT 0,
        launch_info TEXT, result TEXT, cancel_reason TEXT, payload TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        depends_on_run_id TEXT
      );
      CREATE INDEX runs_due ON runs(status, next_attempt_at, priority, created_at);
      CREATE TABLE collaboration_runs (
        workflow_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE collaboration_dispatch_outbox (
        dispatch_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES collaboration_runs(workflow_id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        published_at INTEGER,
        terminal_reason TEXT
      );
      CREATE INDEX collaboration_outbox_pending
        ON collaboration_dispatch_outbox(published_at, dispatch_id);
      CREATE TABLE runtime_provider_health (
        agent TEXT PRIMARY KEY CHECK (agent IN ('grok', 'claude', 'codex')),
        health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
        retry_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
        capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      INSERT INTO runtime_provider_health
        (agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at)
      VALUES ('grok','probing',NULL,0,0,0,0),
             ('claude','probing',NULL,0,0,0,0),
             ('codex','probing',NULL,0,0,0,0);
      CREATE TABLE runtime_review_barriers (
        review_id TEXT PRIMARY KEY,
        stage_id TEXT NOT NULL,
        artifact BLOB NOT NULL,
        artifact_hash TEXT NOT NULL,
        approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
        idempotency_key TEXT NOT NULL,
        run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_REVIEW_SET')),
        created_at INTEGER NOT NULL,
        project TEXT,
        requester TEXT CHECK (requester IS NULL OR requester IN ('grok', 'codex')),
        source_fingerprint TEXT,
        changed_files INTEGER NOT NULL DEFAULT 0 CHECK (changed_files >= 0),
        launch_authority_version INTEGER NOT NULL DEFAULT 1
          CHECK (launch_authority_version IN (1, 2))
      );
      CREATE TABLE runtime_review_lanes (
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'claude', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'glm-5.3', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh', 'max')),
        policy_version TEXT NOT NULL CHECK (policy_version = 'routing-v5'),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        result TEXT,
        error TEXT,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role)
      );
      CREATE INDEX runtime_review_lanes_status ON runtime_review_lanes(review_id, status);
      CREATE TABLE runtime_review_lane_attempts (
        review_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'claude', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (review_id, agent, role, attempt_ordinal),
        FOREIGN KEY (review_id, agent, role)
          REFERENCES runtime_review_lanes(review_id, agent, role) ON DELETE CASCADE
      );
      CREATE INDEX runtime_review_attempts_lane
        ON runtime_review_lane_attempts(review_id, agent, role, attempt_ordinal);
      ${V4_LAUNCH_AUTHORITY_TRIGGERS}
      CREATE TABLE approval_grants (
        reference TEXT NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
        expires_at INTEGER NOT NULL,
        max_uses INTEGER NOT NULL CHECK (max_uses > 0),
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
        PRIMARY KEY (reference, project, scope)
      );
      CREATE TABLE approval_consumptions (
        consumer_key TEXT PRIMARY KEY,
        reference TEXT NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
        consumed_at INTEGER NOT NULL
      );
      CREATE TABLE worktree_leases (
        worktree_path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        holder TEXT NOT NULL CHECK (holder IN ('grok', 'codex')),
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        authority_policy TEXT NOT NULL DEFAULT 'routing-v5'
          CHECK (authority_policy = 'routing-v5')
      );
      CREATE TABLE worktree_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_worktree_handoffs_task
        ON worktree_handoffs(task_id, id);
      ${loadGraphV4Ddl(process.cwd())}
      PRAGMA user_version = 4;
      `);
    });
    initialize.immediate();
    extendReviewV3SchemaOffline(db, options.faultInjector);
  }
}

export function initializeCurrentExecutionSchema(
  path: string,
  options: { faultInjector?: (point: string) => void } = {},
): void {
  const canonicalPath = resolve(path);
  const root = dirname(canonicalPath);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() ||
      realpathSync(root) !== root) {
    throw new Error("fresh state schema requires one canonical existing root");
  }
  const rootLease = acquireStateRootLease(root, "exclusive");
  let db: Database.Database | undefined;
  try {
    options.faultInjector?.("after_state_root_fence");
    const pinnedPath = join(rootLease.pinnedRoot, basename(canonicalPath));
    if (!existsSync(pinnedPath)) closeSync(openSync(pinnedPath, "wx", 0o600));
    rootLease.assertCurrent();
    const identity = canonicalStateDatabaseIdentity(canonicalPath);
    assertCanonicalStateDatabaseIdentity(identity);
    const pinnedIdentity = statSync(pinnedPath);
    if (pinnedIdentity.dev !== identity.databaseIdentity.dev || pinnedIdentity.ino !== identity.databaseIdentity.ino) {
      throw new Error("fresh state database changed below its pinned root");
    }
    db = new Database(pinnedPath);
    assertCanonicalStateDatabaseIdentity(identity);
    initializeCurrentExecutionSchemaDatabase(db, options);
    rootLease.assertCurrent();
  }
  finally {
    db?.close();
    rootLease.release();
  }
}

type HistoryDigest = Record<keyof typeof HISTORY_TABLES, TableDigest>;

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function userVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }));
}

function effectiveV1Version(db: Database.Database, kind: "state" | "history"): number {
  const version = userVersion(db);
  if (version !== 0) return version;
  const required = kind === "state"
    ? ["runs", "runtime_provider_health", "runtime_review_barriers", "runtime_review_lanes", "worktree_leases"]
    : ["sources", "history_rows", "pending_tools", "history_issues"];
  return required.every((table) => tableExists(db, table)) ? V1 : version;
}

function acquireExclusiveOwnership(db: Database.Database): void {
  db.pragma("busy_timeout = 5000");
  db.pragma("locking_mode = EXCLUSIVE");
  db.exec("BEGIN EXCLUSIVE; COMMIT;");
}

function createConsistentBackup(db: Database.Database, destination: string): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec(`VACUUM INTO ${quoteSqlString(destination)}`);
}

const sha256Bytes = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const fsyncPath = (path: string): void => {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
};

const withStateV4ArtifactLeases = <T>(paths: readonly string[], operation: () => T): T => {
  const descriptors: number[] = [];
  try {
    for (const path of paths) {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error("state-v4 signed artifact must be one regular file");
      }
      const descriptor = openSync(path, "r");
      const locked = spawnSync("/usr/bin/flock", ["-w", "5", "-x", "3"], {
        encoding: "utf8", stdio: ["ignore", "ignore", "pipe", descriptor],
      });
      if (locked.error || locked.status !== 0) {
        closeSync(descriptor);
        throw new Error(`state-v4 artifact lease busy: ${locked.error?.message ?? locked.stderr ?? "flock denied"}`);
      }
      const after = statSync(path);
      const opened = fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino ||
          after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1) {
        closeSync(descriptor);
        throw new Error("state-v4 signed artifact identity changed during lease acquisition");
      }
      descriptors.push(descriptor);
    }
    return operation();
  } finally {
    for (const descriptor of descriptors.reverse()) closeSync(descriptor);
  }
};

const loadGraphV4Ddl = (repositoryRoot: string): string => {
  const path = resolve(repositoryRoot, "docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql");
  const bytes = readFileSync(path, "utf8");
  if (sha256Bytes(bytes) !== GRAPH_V4_DDL_SHA256) {
    throw new Error("STATE_V4_SCHEMA.sql hash does not match the immutable contract");
  }
  return bytes;
};

const sqliteValue = (value: unknown): unknown => {
  if (value === null || typeof value === "string") return { type: value === null ? "null" : "text", value };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("legacy table contains an unsafe SQLite integer");
    return { type: "integer", value: value.toString() };
  }
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (Buffer.isBuffer(value)) return { type: "blob", value: value.toString("base64") };
  throw new Error(`unsupported SQLite value in legacy manifest: ${typeof value}`);
};

interface LegacyTableManifest {
  schemaVersion: "legacy-table-digest-manifest/v1";
  tables: Array<{ name: string; columns: string[]; rowCount: number; rowsSha256: string }>;
}

const legacyTableManifest = (
  db: Database.Database,
  expected?: LegacyTableManifest,
): LegacyTableManifest => {
  const graphTables = new Set<string>(GRAPH_V4_TABLES);
  const tables = expected?.tables.map(({ name }) => name) ??
    (db.prepare(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[])
      .filter((name) => !graphTables.has(name));
  return {
    schemaVersion: "legacy-table-digest-manifest/v1",
    tables: tables.map((name) => {
      const escaped = name.replaceAll('"', '""');
      const actualColumns = (db.pragma(`table_info('${name.replaceAll("'", "''")}')`) as Array<{ name: string }>)
        .map(({ name: column }) => column);
      const columns = expected?.tables.find((table) => table.name === name)?.columns ?? actualColumns;
      if (columns.some((column) => !actualColumns.includes(column))) {
        throw new Error(`legacy manifest column disappeared: ${name}`);
      }
      const digest = createHash("sha256");
      let rowCount = 0;
      for (const row of db.prepare(`SELECT * FROM "${escaped}" ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
        digest.update(canonicalJson(columns.map((column) => sqliteValue(row[column]))));
        digest.update("\n");
        rowCount += 1;
      }
      return { name, columns, rowCount, rowsSha256: digest.digest("hex") };
    }),
  };
};

const manifestSha256 = (manifest: LegacyTableManifest): string =>
  sha256Bytes(canonicalJson(manifest));

const databaseIdentity = (path: string): string => {
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  return sha256Bytes(canonicalJson({ path: canonical, device: stat.dev, inode: stat.ino }));
};

const reusableActiveMigrationArtifacts = (input: {
  layout: ReturnType<typeof ensureStateV4MigrationLayout>;
  backupRoot: string;
  databaseIdentity: string;
  tableDigestManifestSha256: string;
  writeEpoch: string;
}): { backupPath: string; tableDigestManifestPath: string; backupSha256: string;
  guardPath: string; guardExists: boolean } | undefined => {
  const { layout } = input;
  const descriptor = readActiveStateV4GuardDescriptor(layout.root);
  if (descriptor === undefined) return undefined;
  if (descriptor.databaseIdentity !== input.databaseIdentity ||
      descriptor.tableDigestManifestSha256 !== input.tableDigestManifestSha256 ||
      descriptor.writeEpoch !== input.writeEpoch) {
    throw new Error("active state-v4 migration artifacts do not match the current write epoch");
  }
  const assertOwnedArtifact = (root: string, path: string, label: string): string => {
    const target = resolve(path);
    const rel = relative(resolve(root), target);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`active state-v4 ${label} path escapes its artifact root`);
    }
    return target;
  };
  const backupPath = assertOwnedArtifact(input.backupRoot, descriptor.backupPath, "backup");
  const tableDigestManifestPath = assertOwnedArtifact(
    input.backupRoot, descriptor.tableDigestManifestPath, "manifest",
  );
  const guardPath = assertOwnedArtifact(layout.guardDirectory, descriptor.guardPath, "guard");
  if (tableDigestManifestPath !== `${backupPath}.manifest.json` ||
      guardPath !== resolve(layout.guardDirectory, `state-v4-${descriptor.backupSha256}.jsonl`)) {
    throw new Error("active state-v4 artifact paths do not match their canonical identities");
  }
  const guardExists = existsSync(guardPath);
  if (guardExists) {
    const guard = new StateV4RestoreGuard({
      journalPath: guardPath,
      databaseIdentity: descriptor.databaseIdentity,
      backupSha256: descriptor.backupSha256,
      tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
      writeEpoch: descriptor.writeEpoch,
    });
    const records = guard.readAndVerify();
    if (records.length !== 1 || records[0]?.event !== "backup_created") {
      throw new Error("state-v4 migration cannot reuse a restore guard after reopen, write, or restore");
    }
  } else if (existsSync(`${guardPath}.pending`) || existsSync(`${guardPath}.tmp`)) {
    throw new Error("state-v4 restore guard has an interrupted durable write");
  }
  if (!existsSync(backupPath) || !lstatSync(backupPath).isFile() || lstatSync(backupPath).isSymbolicLink() ||
      sha256Bytes(readFileSync(backupPath)) !== descriptor.backupSha256) {
    throw new Error("active state-v4 backup is missing or does not match its descriptor");
  }
  if (!existsSync(tableDigestManifestPath)) throw new Error("active state-v4 backup manifest is missing");
  const manifestBytes = readFileSync(tableDigestManifestPath, "utf8");
  const manifest = JSON.parse(manifestBytes) as LegacyTableManifest;
  if (`${canonicalJson(manifest)}\n` !== manifestBytes ||
      manifestSha256(manifest) !== input.tableDigestManifestSha256) {
    throw new Error("active state-v4 backup manifest does not match the write epoch");
  }
  return { backupPath, tableDigestManifestPath, backupSha256: descriptor.backupSha256,
    guardPath, guardExists };
};

const adoptablePreDescriptorArtifacts = (input: {
  backupRoot: string;
  tableDigestManifestSha256: string;
  stateSchemaSha256: string;
}): { backupPath: string; tableDigestManifestPath: string } | undefined => {
  const matches = readdirSync(input.backupRoot).filter((name) => name.endsWith(".db")).sort()
    .map((name) => resolve(input.backupRoot, name))
    .filter((backupPath) => {
      const manifestPath = `${backupPath}.manifest.json`;
      if (!lstatSync(backupPath).isFile() || lstatSync(backupPath).isSymbolicLink() || !existsSync(manifestPath) ||
          !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) return false;
      const bytes = readFileSync(manifestPath, "utf8");
      let candidate: Database.Database | undefined;
      try {
        const manifest = JSON.parse(bytes) as LegacyTableManifest;
        if (`${canonicalJson(manifest)}\n` !== bytes ||
            manifestSha256(manifest) !== input.tableDigestManifestSha256) return false;
        candidate = new Database(backupPath, { readonly: true, fileMustExist: true });
        candidate.pragma("query_only = ON");
        return schemaSha256(candidate) === input.stateSchemaSha256;
      } catch {
        return false;
      } finally {
        candidate?.close();
      }
    });
  if (matches.length > 1) throw new Error("multiple pre-descriptor state-v4 backups require operator reconciliation");
  const backupPath = matches[0];
  return backupPath ? { backupPath, tableDigestManifestPath: `${backupPath}.manifest.json` } : undefined;
};

interface VerifiedProgressEvent {
  planId: string;
  sequence: number;
  eventId: string;
  startSha256: string;
  previousEventSha256: string;
  effectivePlanSha256: string;
  eventSha256: string;
  recordedAt: string;
  eventJson: string;
}

interface VerifiedProgressBundle {
  events: VerifiedProgressEvent[];
  lastEventSha256: string;
}

interface ProgressVerificationSummary {
  startSha256: string;
  progressEventCount: number;
  lastEventSha256: string;
  events: Array<{ stageId: string; terminalResult: string; eventSha256: string }>;
}

export function bindRereadProgressEvents(
  verification: ProgressVerificationSummary,
  eventPayloads: readonly string[],
): VerifiedProgressBundle {
  if (eventPayloads.length !== verification.progressEventCount) {
    throw new Error("pre-v4 progress inventory changed after verification");
  }
  let previousEventSha256 = verification.startSha256;
  const events = eventPayloads.map((payload, offset) => {
    const event = JSON.parse(payload) as VerifiedProgressEvent;
    const digestInput = { ...event } as Record<string, unknown>;
    delete digestInput.eventSha256;
    const rereadDigest = sha256Bytes(canonicalJson(digestInput));
    if (event.sequence !== offset + 1 || event.previousEventSha256 !== previousEventSha256 ||
        event.eventSha256 !== rereadDigest || rereadDigest !== verification.events[offset]?.eventSha256) {
      throw new Error("pre-v4 progress bytes changed after verification");
    }
    previousEventSha256 = rereadDigest;
    return { ...event, eventJson: canonicalJson(event) };
  });
  if (previousEventSha256 !== verification.lastEventSha256 ||
      events.at(-1)?.eventSha256 !== verification.lastEventSha256) {
    throw new Error("pre-v4 progress terminal hash changed after verification");
  }
  return { events, lastEventSha256: verification.lastEventSha256 };
}

const loadVerifiedProgressBundle = (
  repositoryRoot: string,
  progressPackagePath: string,
  faultInjector?: (point: MigrationFaultPoint) => void,
): VerifiedProgressBundle => {
  const packageRoot = resolve(repositoryRoot, progressPackagePath);
  const packageArgument = relative(repositoryRoot, packageRoot);
  if (packageArgument.startsWith("..")) throw new Error("progress package is outside repository root");
  const verification = JSON.parse(execFileSync(process.execPath, [
    resolve(repositoryRoot, "scripts/verify-implementation-progress.mjs"),
    "--root", repositoryRoot,
    "--git-root", repositoryRoot,
    "--package", packageArgument,
  ], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as ProgressVerificationSummary & {
    status: string;
  };
  if (verification.status !== "verified" || verification.progressEventCount < 3 ||
      verification.events.at(-1)?.stageId !== "STG-02" ||
      verification.events.at(-1)?.terminalResult !== "PASS") {
    throw new Error("verified pre-v4 progress chain must end at STG-02 PASS");
  }
  faultInjector?.("after_v4_progress_verify");
  const progressRoot = resolve(packageRoot, "stage-close/pre-v4");
  const files = readdirSync(progressRoot).filter((name) => name.endsWith(".json")).sort();
  return bindRereadProgressEvents(
    verification,
    files.map((name) => readFileSync(resolve(progressRoot, name), "utf8")),
  );
};

export function restoreStateV4Backup(input: {
  stateDatabase: string;
  receipt: Pick<V4MigrationReceipt,
    "backupPath" | "backupSha256" | "guardPath" | "databaseIdentity" |
    "tableDigestManifestSha256" | "tableDigestManifestPath" | "writeEpoch">;
  faultInjector?: (point: MigrationFaultPoint) => void;
}): { status: "restored" | "recovered"; stateDatabase: string; backupSha256: string } {
  const stateIdentity = canonicalStateDatabaseIdentity(input.stateDatabase);
  const rootLease = acquireStateRootLease(stateIdentity.root, "exclusive");
  const operationRoot = rootLease.pinnedRoot;
  const stateDatabase = join(operationRoot, basename(stateIdentity.path));
  const stateRoot = stateIdentity.root;
  const pinRootPath = (path: string): string => {
    const rel = relative(stateIdentity.root, resolve(path));
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
      ? join(operationRoot, rel)
      : path;
  };
  try {
  rootLease.assertCurrent();
  return (() => {
  requireStateV4RestoreAuthority(stateRoot, input.receipt, operationRoot);
  const receipt = { ...input.receipt, backupPath: pinRootPath(input.receipt.backupPath),
    tableDigestManifestPath: pinRootPath(input.receipt.tableDigestManifestPath),
    guardPath: pinRootPath(input.receipt.guardPath) };
  for (const [path, label] of [[stateDatabase, "state"], [receipt.backupPath, "backup"],
    [receipt.tableDigestManifestPath, "manifest"]] as const) {
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`state-v4 ${label} must be an existing regular file`);
    }
  }
  if (sha256Bytes(readFileSync(receipt.backupPath)) !== receipt.backupSha256) {
    throw new Error("state-v4 backup hash mismatch");
  }
  const manifestBytes = readFileSync(receipt.tableDigestManifestPath, "utf8");
  if (!manifestBytes.endsWith("\n")) throw new Error("state-v4 manifest is truncated");
  const expectedManifest = JSON.parse(manifestBytes) as LegacyTableManifest;
  if (`${canonicalJson(expectedManifest)}\n` !== manifestBytes ||
      manifestSha256(expectedManifest) !== receipt.tableDigestManifestSha256) {
    throw new Error("state-v4 manifest hash or canonical bytes mismatch");
  }
  const guard = new StateV4RestoreGuard({
    journalPath: receipt.guardPath,
    databaseIdentity: receipt.databaseIdentity,
    backupSha256: receipt.backupSha256,
    tableDigestManifestSha256: receipt.tableDigestManifestSha256,
    writeEpoch: receipt.writeEpoch,
  });
  const records = guard.readAndVerify();
  const staged = `${stateDatabase}.restore-${receipt.backupSha256}.staged`;
  const finishConsumedRestore = (status: "restored" | "recovered") => {
    rootLease.assertCurrent();
    rmSync(`${stateDatabase}-wal`, { force: true });
    rmSync(`${stateDatabase}-shm`, { force: true });
    rmSync(`${stateDatabase}-journal`, { force: true });
    rmSync(staged, { force: true });
    fsyncPath(dirname(stateDatabase));
    input.faultInjector?.("after_v4_restore_root_fsync");
    requireStateV4RestoreAuthority(stateRoot, input.receipt, operationRoot);
    const active = readActiveStateV4GuardDescriptor(stateRoot, operationRoot);
    const retirementPending = existsSync(resolve(operationRoot, "migration-v4/retirement.pending"));
    if (active) {
      retireConsumedStateV4Descriptor(stateRoot, input.faultInjector, operationRoot);
    } else if (retirementPending) {
      retireConsumedStateV4Descriptor(stateRoot, input.faultInjector, operationRoot);
    } else if (!retiredStateV4Descriptors(stateRoot, operationRoot).some((retired) =>
      retired.backupSha256 === input.receipt.backupSha256 && retired.guardPath === input.receipt.guardPath)) {
      throw new Error("consumed state-v4 authority is missing after physical recovery");
    }
    rootLease.assertCurrent();
    return { status, stateDatabase: stateIdentity.path, backupSha256: receipt.backupSha256 };
  };
  if (records.at(-1)?.event === "restore_consumed") {
    if (sha256Bytes(readFileSync(stateDatabase)) === receipt.backupSha256) {
      return finishConsumedRestore("recovered");
    }
    if (!existsSync(staged) || sha256Bytes(readFileSync(staged)) !== receipt.backupSha256) {
      throw new Error("consumed state-v4 restore requires operator reconciliation");
    }
    rootLease.assertCurrent();
    rmSync(`${stateDatabase}-wal`, { force: true });
    rmSync(`${stateDatabase}-shm`, { force: true });
    renameSync(staged, stateDatabase);
    fsyncPath(dirname(stateDatabase));
    return finishConsumedRestore("recovered");
  }
  const current = new Database(stateDatabase, { readonly: true, fileMustExist: true });
  let currentManifest: LegacyTableManifest;
  try {
    current.pragma("query_only = ON");
    if (String(current.pragma("integrity_check", { simple: true })) !== "ok" ||
        (current.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("current state database fails restore integrity preflight");
    }
    currentManifest = legacyTableManifest(current, expectedManifest);
  } finally {
    current.close();
  }
  if (databaseIdentity(stateDatabase) !== receipt.databaseIdentity ||
      manifestSha256(currentManifest) !== receipt.tableDigestManifestSha256 ||
      sha256Bytes(canonicalJson({
        databaseIdentity: receipt.databaseIdentity,
        tableDigestManifestSha256: manifestSha256(currentManifest),
      })) !== receipt.writeEpoch) {
    throw new Error("state-v4 restore rejected because the write epoch or legacy rows changed");
  }
  assertPhysicalRestoreAllowed(receipt, records, {
    writeEpoch: receipt.writeEpoch,
    tableDigestManifestSha256: receipt.tableDigestManifestSha256,
  });
  if (existsSync(staged)) {
    if (!lstatSync(staged).isFile() || lstatSync(staged).isSymbolicLink() ||
        sha256Bytes(readFileSync(staged)) !== receipt.backupSha256) {
      throw new Error("state-v4 staged restore is not recoverable");
    }
  } else {
    rootLease.assertCurrent();
    copyFileSync(receipt.backupPath, staged);
    fsyncPath(staged);
  }
  if (sha256Bytes(readFileSync(staged)) !== receipt.backupSha256) {
    throw new Error("staged state-v4 restore hash mismatch");
  }
  input.faultInjector?.("after_v4_restore_staged");
  rootLease.assertCurrent();
  guard.append("restore_consumed", Date.now());
  input.faultInjector?.("after_v4_restore_consumed");
  rmSync(`${stateDatabase}-wal`, { force: true });
  rmSync(`${stateDatabase}-shm`, { force: true });
  renameSync(staged, stateDatabase);
  input.faultInjector?.("after_v4_restore_renamed");
  return finishConsumedRestore("restored");
  })();
  } finally {
    rootLease.release();
  }
}

function blockingTables(db: Database.Database): string[] {
  return MUTABLE_RUNTIME_TABLES.filter((table) => {
    if (!tableExists(db, table)) return false;
    return Number(db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()) > 0;
  });
}

function blockingV3Tables(db: Database.Database): string[] {
  return V3_GUARDED_TABLES.filter((table) => {
    if (!tableExists(db, table)) return false;
    return Number(db.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get()) > 0;
  });
}

function assertSafePendingTools(db: Database.Database): void {
  if (!tableExists(db, "pending_tools")) return;
  const rows = db.prepare("SELECT project,source_path,name FROM pending_tools").all() as Array<{
    project: string; source_path: string; name: string;
  }>;
  for (const row of rows) {
    const safeName = /^[A-Za-z0-9_.:-]{1,128}$/.test(row.name) &&
      Buffer.byteLength(row.name, "utf8") <= 128 && redactSensitive(row.name) === row.name;
    const project = resolve(row.project);
    const source = resolve(row.source_path);
    const safePaths = row.project.startsWith("/") && row.source_path.startsWith("/") &&
      project === row.project && source === row.source_path && project !== "/" && source !== "/" &&
      redactSensitive(row.project) === row.project && redactSensitive(row.source_path) === row.source_path;
    if (!safeName || !safePaths) {
      throw new Error("unsafe pending tool entry blocks v2 migration");
    }
  }
}

function historyDigest(db: Database.Database, mapLegacyClaude: boolean): HistoryDigest {
  return Object.fromEntries(Object.entries(HISTORY_TABLES).map(([table, columns]) => {
    const digest = createHash("sha256");
    let count = 0;
    const order = table === "history_issues"
      ? "project,source_path,code,source_line"
      : columns.slice(0, table === "sources" ? 2 : 3).join(",");
    const hasNamespace = table === "history_rows" &&
      (db.pragma("table_info(history_rows)") as Array<{ name: string }>).some((column) => column.name === "namespace");
    const selectedColumns = hasNamespace ? [...columns, "namespace"] : columns;
    const rows = db.prepare(`SELECT ${selectedColumns.join(",")} FROM ${table} ORDER BY ${order}`).iterate() as Iterable<Record<string, unknown>>;
    for (const row of rows) {
      const values = columns.map((column) => {
        const value = row[column];
        if (mapLegacyClaude && (column === "agent" || column === "source_agent") && value === "claude") {
          return "claude_legacy";
        }
        return value;
      });
      if (table === "history_rows") {
        const expectedNamespace = historyNamespace(values[3]);
        values.push(hasNamespace ? row.namespace : expectedNamespace);
      }
      digest.update(JSON.stringify(values));
      digest.update("\n");
      count += 1;
    }
    return [table, { count, sha256: digest.digest("hex") }];
  })) as HistoryDigest;
}

function migrateState(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      DROP TABLE runtime_provider_health;
      CREATE TABLE runtime_provider_health (
        agent TEXT PRIMARY KEY CHECK (agent IN ('grok', 'codex')),
        health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
        retry_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
        capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      INSERT INTO runtime_provider_health
        (agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at)
      VALUES ('grok','probing',NULL,0,0,0,0), ('codex','probing',NULL,0,0,0,0);

      ALTER TABLE collaboration_dispatch_outbox ADD COLUMN terminal_reason TEXT;

      DROP INDEX runtime_review_lanes_status;
      DROP TABLE runtime_review_lanes;
      DROP TABLE runtime_review_barriers;
      CREATE TABLE runtime_review_barriers (
        review_id TEXT PRIMARY KEY,
        stage_id TEXT NOT NULL,
        artifact BLOB NOT NULL,
        artifact_hash TEXT NOT NULL,
        approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
        idempotency_key TEXT NOT NULL,
        run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_SINGLE_PROVIDER')),
        created_at INTEGER NOT NULL,
        project TEXT,
        requester TEXT CHECK (requester IS NULL OR requester IN ('grok', 'codex')),
        source_fingerprint TEXT,
        changed_files INTEGER NOT NULL DEFAULT 0 CHECK (changed_files >= 0)
      );
      CREATE TABLE runtime_review_lanes (
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
        policy_version TEXT NOT NULL CHECK (policy_version = 'routing-v4'),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        result TEXT,
        error TEXT,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role)
      );
      CREATE INDEX runtime_review_lanes_status ON runtime_review_lanes(review_id, status);
      CREATE TABLE runtime_review_lane_attempts (
        review_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (review_id, agent, role, attempt_ordinal),
        FOREIGN KEY (review_id, agent, role)
          REFERENCES runtime_review_lanes(review_id, agent, role) ON DELETE CASCADE
      );
      CREATE INDEX runtime_review_attempts_lane
        ON runtime_review_lane_attempts(review_id, agent, role, attempt_ordinal);

      DROP TABLE worktree_leases;
      CREATE TABLE worktree_leases (
        worktree_path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        holder TEXT NOT NULL CHECK (holder IN ('grok', 'codex')),
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        authority_policy TEXT NOT NULL DEFAULT 'routing-v4'
          CHECK (authority_policy IN ('routing-v3', 'routing-v4'))
      );
      CREATE TABLE approval_consumptions (
        consumer_key TEXT PRIMARY KEY,
        reference TEXT NOT NULL,
        project TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
        consumed_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
  });
  migrate.immediate();
}

function migrateHistory(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      DROP INDEX history_rows_project;
      ALTER TABLE sources RENAME TO sources_v1;
      ALTER TABLE history_rows RENAME TO history_rows_v1;
      ALTER TABLE pending_tools RENAME TO pending_tools_v1;

      CREATE TABLE sources (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
        checkpoint_offset INTEGER NOT NULL,
        checkpoint_line INTEGER NOT NULL,
        prefix_hash TEXT NOT NULL,
        session_id TEXT,
        PRIMARY KEY (project, source_path)
      );
      CREATE TABLE history_rows (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        record_key TEXT NOT NULL,
        source_agent TEXT NOT NULL CHECK (source_agent IN ('grok', 'codex', 'claude_legacy')),
        namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native', 'claude_legacy', 'collaboration_shared')),
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'message', 'tool_summary')),
        session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('assistant', 'memory', 'user')),
        content TEXT NOT NULL,
        source_line INTEGER NOT NULL,
        timestamp TEXT,
        content_hash TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (trust = 'untrusted'),
        PRIMARY KEY (project, source_path, record_key)
      );
      CREATE INDEX history_rows_project ON history_rows(project, source_agent, source_path, source_line);
      CREATE TABLE pending_tools (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        call_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
        name TEXT NOT NULL,
        session_id TEXT,
        source_line INTEGER NOT NULL,
        timestamp TEXT,
        record_key TEXT NOT NULL,
        PRIMARY KEY (project, source_path, call_id)
      );
      CREATE TABLE memory_source_health (
        project TEXT NOT NULL,
        namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native')),
        status TEXT NOT NULL CHECK (status IN ('projected', 'unavailable', 'no_project_section')),
        source_path TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, namespace)
      );

      INSERT INTO sources
        (project,source_path,agent,checkpoint_offset,checkpoint_line,prefix_hash,session_id)
      SELECT project,source_path,CASE agent WHEN 'claude' THEN 'claude_legacy' ELSE agent END,
             checkpoint_offset,checkpoint_line,prefix_hash,session_id
        FROM sources_v1;
      INSERT INTO history_rows
        (project,source_path,record_key,source_agent,namespace,kind,session_id,role,content,source_line,timestamp,content_hash,trust)
      SELECT project,source_path,record_key,
             CASE source_agent WHEN 'claude' THEN 'claude_legacy' ELSE source_agent END,
             CASE source_agent
               WHEN 'grok' THEN 'grok_native'
               WHEN 'codex' THEN 'codex_native'
               WHEN 'claude' THEN 'claude_legacy'
               WHEN 'claude_legacy' THEN 'claude_legacy'
             END,
             kind,session_id,role,content,source_line,timestamp,content_hash,trust
        FROM history_rows_v1;
      INSERT INTO pending_tools
        (project,source_path,call_id,agent,name,session_id,source_line,timestamp,record_key)
      SELECT project,source_path,call_id,CASE agent WHEN 'claude' THEN 'claude_legacy' ELSE agent END,
             name,session_id,source_line,timestamp,record_key
        FROM pending_tools_v1;

      DROP TABLE pending_tools_v1;
      DROP TABLE history_rows_v1;
      DROP TABLE sources_v1;
      PRAGMA user_version = 2;
    `);
  });
  migrate.immediate();
}

function requireAgentConstraint(db: Database.Database, table: string, legacy = false): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
  if (!row || !row.sql.includes("'grok'") || !row.sql.includes("'codex'") ||
      (!legacy && /'claude'(?!_legacy)/.test(row.sql)) || (legacy && !row.sql.includes("'claude_legacy'"))) {
    throw new Error(`invalid v2 agent constraint: ${table}`);
  }
}

function verifyV2(state: Database.Database, history: Database.Database): void {
  if (userVersion(state) !== V2 || userVersion(history) !== V2) throw new Error("v2 schema marker mismatch");
  const agents = state.prepare("SELECT agent,health FROM runtime_provider_health ORDER BY agent").all();
  if (!isDeepStrictEqual(agents, [{ agent: "codex", health: "probing" }, { agent: "grok", health: "probing" }])) {
    throw new Error("v2 provider health initialization mismatch");
  }
  for (const table of ["runtime_provider_health", "runtime_review_barriers", "runtime_review_lanes", "runtime_review_lane_attempts", "worktree_leases"]) {
    requireAgentConstraint(state, table);
  }
  const reviewLaneSql = (state.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_review_lanes'",
  ).get() as { sql: string } | undefined)?.sql ?? "";
  const reviewAttemptSql = (state.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='runtime_review_lane_attempts'",
  ).get() as { sql: string } | undefined)?.sql ?? "";
  if (!reviewLaneSql.includes("'routing-v4'") || !reviewAttemptSql.includes("run_id") ||
      reviewAttemptSql.includes("policy_version") || reviewAttemptSql.includes("status TEXT")) {
    throw new Error("v2 review schema is not routing-v4 capable");
  }
  const leaseColumns = new Set(
    (state.prepare("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  const outboxColumns = new Set(
    (state.prepare("PRAGMA table_info(collaboration_dispatch_outbox)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!leaseColumns.has("authority_policy") || !outboxColumns.has("terminal_reason")) {
    throw new Error("v2 routing-v4 durability columns are missing");
  }
  verifyHistoryV2Schema(history);
  if ((state.pragma("foreign_key_check") as unknown[]).length > 0 ||
      (history.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new Error("v2 foreign-key verification failed");
  }
  for (const [db, indexes] of [[state, ["runs_due", "collaboration_outbox_pending", "runtime_review_lanes_status", "runtime_review_attempts_lane", "idx_worktree_handoffs_task"]],
    [history, []]] as const) {
    for (const index of indexes) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index) === undefined) {
        throw new Error(`missing v2 index: ${index}`);
      }
    }
  }
}

function schemaSql(db: Database.Database, table: string): string {
  return (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql: string } | undefined)?.sql ?? "";
}

interface SchemaObjectRow {
  type: string;
  name: string;
  tblName: string;
  sql: string | null;
}

const normalizedSchemaRows = (
  db: Database.Database,
  names?: readonly string[],
): SchemaObjectRow[] => {
  const where = names === undefined
    ? "name NOT LIKE 'sqlite_%'"
    : `name IN (${names.map(() => "?").join(",")})`;
  return (db.prepare(`SELECT type,name,tbl_name AS tblName,sql FROM sqlite_schema
    WHERE ${where} ORDER BY type,name`).all(...(names ?? [])) as SchemaObjectRow[])
    .map((row) => ({
      ...row,
      sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : null,
    }));
};

const schemaRowsSha256 = (rows: readonly SchemaObjectRow[]): string => {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`${JSON.stringify(row)}\n`);
  return digest.digest("hex");
};

const schemaSha256 = (db: Database.Database): string =>
  schemaRowsSha256(normalizedSchemaRows(db));

const legacyStateSchemaSha256 = (db: Database.Database): string => {
  const graphTables = new Set<string>(GRAPH_V4_TABLES);
  return schemaRowsSha256(normalizedSchemaRows(db).filter((row) =>
    (row.type === "table" || row.type === "trigger" || row.type === "view") &&
    !graphTables.has(row.name)));
};

const assertExactIndex = (
  db: Database.Database,
  name: string,
  columns: readonly string[],
): void => {
  const schema = db.prepare("SELECT tbl_name AS tableName FROM sqlite_schema WHERE type='index' AND name=?")
    .get(name) as { tableName: string } | undefined;
  const escapedTable = schema?.tableName.replaceAll("'", "''") ?? "";
  const metadata = schema === undefined ? undefined : (db.pragma(
    `index_list('${escapedTable}')`,
  ) as Array<{ name: string; unique: 0 | 1; origin: string; partial: 0 | 1 }>)
    .find((index) => index.name === name);
  const escapedName = name.replaceAll("'", "''");
  const keyColumns = schema === undefined ? [] : (db.pragma(
    `index_xinfo('${escapedName}')`,
  ) as Array<{ seqno: number; name: string | null; desc: 0 | 1; coll: string; key: 0 | 1 }>)
    .filter(({ key }) => key === 1)
    .sort((left, right) => left.seqno - right.seqno);
  if (!metadata || metadata.unique !== 0 || metadata.origin !== "c" || metadata.partial !== 0 ||
      keyColumns.length !== columns.length || keyColumns.some((column, offset) =>
        column.name !== columns[offset] || column.desc !== 0 || column.coll.toUpperCase() !== "BINARY")) {
    throw new Error(`invalid index signature: ${name}`);
  }
};

const assertNoAdditiveUniqueIndexes = (db: Database.Database): void => {
  const tables = db.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[];
  const unexpected = tables.flatMap((table) => db.pragma(
    `index_list('${table.replaceAll("'", "''")}')`,
  ) as Array<{ name: string; unique: 0 | 1; origin: string }>).filter((index) =>
    index.origin === "c" && index.unique === 1);
  if (unexpected.length > 0) {
    throw new Error(`additive unique indexes are forbidden: ${unexpected.map(({ name }) => name).join(", ")}`);
  }
};

function verifyHistoryV2Schema(history: Database.Database, exactProfile = false): void {
  if (userVersion(history) !== V2) throw new Error("v2 history schema marker mismatch");
  for (const table of ["sources", "history_rows", "pending_tools"]) {
    requireAgentConstraint(history, table, true);
  }
  if (!tableExists(history, "history_issues") || !tableExists(history, "memory_source_health")) {
    throw new Error("missing v2 history table");
  }
  const historyRowsSql = schemaSql(history, "history_rows");
  for (const namespace of ["grok_native", "codex_native", "claude_legacy", "collaboration_shared"]) {
    if (!historyRowsSql.includes(`'${namespace}'`)) {
      throw new Error(`invalid v2 history namespace constraint: ${namespace}`);
    }
  }
  if (history.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='history_rows_project'",
  ).get() === undefined) {
    throw new Error("missing v2 index: history_rows_project");
  }
  if (exactProfile) {
    assertExactIndex(history, "history_rows_project", ["project", "source_agent", "source_path", "source_line"]);
    assertNoAdditiveUniqueIndexes(history);
    const exactSchema = schemaRowsSha256(normalizedSchemaRows(history).filter((row) =>
      row.type === "table" || row.type === "trigger" || row.type === "view"));
    if (!HISTORY_V2_SCHEMA_SHA256.some((expected) => exactSchema === expected)) {
      throw new Error("history v2 schema profile mismatch");
    }
  }
}

function verifyRoutingV5State(state: Database.Database, version: 3 | 4): void {
  if (userVersion(state) !== version) throw new Error(`v${version} state schema marker mismatch`);

  const healthSql = schemaSql(state, "runtime_provider_health");
  const barrierSql = schemaSql(state, "runtime_review_barriers");
  const laneSql = schemaSql(state, "runtime_review_lanes");
  const attemptSql = schemaSql(state, "runtime_review_lane_attempts");
  const leaseSql = schemaSql(state, "worktree_leases");
  const compactBarrierSql = barrierSql.replace(/\s+/g, "");
  const compactLaneSql = laneSql.replace(/\s+/g, "");
  const compactLeaseSql = leaseSql.replace(/\s+/g, "");
  for (const provider of ["grok", "claude", "codex"]) {
    if (!healthSql.includes(`'${provider}'`) ||
        !laneSql.includes(`'${provider}'`) ||
        !attemptSql.includes(`'${provider}'`)) {
      throw new Error(`invalid v${version} review provider constraint: ${provider}`);
    }
  }
  for (const model of ["grok-4.6", "glm-5.3", "gpt-5.6-sol"]) {
    if (!laneSql.includes(`'${model}'`)) throw new Error(`invalid v${version} review model constraint: ${model}`);
  }
  for (const effort of ["high", "xhigh", "max"]) {
    if (!laneSql.includes(`'${effort}'`)) throw new Error(`invalid v${version} review effort constraint: ${effort}`);
  }
  if (!compactBarrierSql.includes("'DEGRADED_REVIEW_SET'") ||
      !compactLaneSql.includes("policy_version='routing-v5'") ||
      !compactBarrierSql.includes("requesterIN('grok','codex')") ||
      !compactLeaseSql.includes("holderIN('grok','codex')") ||
      compactLeaseSql.includes("'claude'") ||
      !compactLeaseSql.includes("DEFAULT'routing-v5'")) {
    throw new Error(`v${version} routing-v5 schema constraints are incomplete`);
  }
  const claude = state.prepare("SELECT agent FROM runtime_provider_health WHERE agent='claude'").get();
  if (!isDeepStrictEqual(claude, { agent: "claude" })) {
    throw new Error(`v${version} Claude provider health row is missing`);
  }
  if ((state.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new Error(`v${version} state foreign-key verification failed`);
  }
  for (const [index, columns] of [
    ["runs_due", ["status", "next_attempt_at", "priority", "created_at"]],
    ["collaboration_outbox_pending", ["published_at", "dispatch_id"]],
    ["runtime_review_lanes_status", ["review_id", "status"]],
    ["runtime_review_attempts_lane", ["review_id", "agent", "role", "attempt_ordinal"]],
  ] as const) {
    try {
      assertExactIndex(state, index, columns);
    } catch {
      throw new Error(`missing v${version} index: ${index}; or invalid signature`);
    }
  }
}

function verifyV3State(state: Database.Database): void {
  verifyRoutingV5State(state, V3);
}

function verifyLaunchAuthorityV4(state: Database.Database): void {
  const barrierSql = schemaSql(state, "runtime_review_barriers");
  const authority = (state.prepare("PRAGMA table_info(runtime_review_barriers)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((column) => column.name === "launch_authority_version");
  if (!authority || authority.notnull !== 1 || authority.dflt_value !== "1" ||
      !barrierSql.includes("launch_authority_version IN (1, 2)")) {
    throw new Error("v4 launch authority column is invalid");
  }
  const triggers = {
    runtime_review_attempt_v2_insert: ["BEFORE INSERT", "NEW.attempt_ordinal <> 0", "permits one lane attempt"],
    runtime_review_attempt_v2_update: ["BEFORE UPDATE", "NEW.attempt_ordinal <> 0", "rowid <> OLD.rowid"],
    runtime_review_barrier_v2_update: ["BEFORE UPDATE OF launch_authority_version", "COUNT(*) > 1", "MAX(attempt_ordinal) <> 0"],
  } as const;
  for (const [trigger, fragments] of Object.entries(triggers)) {
    const sql = (state.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger) as {
      sql: string;
    } | undefined)?.sql ?? "";
    if (fragments.some((fragment) => !sql.includes(fragment))) {
      throw new Error(`missing v4 launch authority trigger: ${trigger}`);
    }
  }
}

function verifyV4State(state: Database.Database): void {
  verifyRoutingV5State(state, V4);
  if (tableExists(state, "runtime_schema_capabilities")) assertReviewV3SchemaSignature(state);
  else verifyLaunchAuthorityV4(state);
  if (graphSchemaState(state) !== "complete_disabled") {
    throw new Error("v4 graph schema is not complete");
  }
}

export function verifyCompatibilityRuntime(input: {
  stateDatabase: string;
  historyDatabase: string;
  faultInjector?: (point: "after_snapshot") => void;
}): CompatibilityRuntimeObservation {
  const stateIdentity = canonicalStateDatabaseIdentity(input.stateDatabase);
  const historyIdentity = canonicalStateDatabaseIdentity(input.historyDatabase);
  if (stateIdentity.path === historyIdentity.path) throw new Error("state and history databases must be distinct");
  if (stateIdentity.root !== historyIdentity.root ||
      stateIdentity.rootIdentity.dev !== historyIdentity.rootIdentity.dev ||
      stateIdentity.rootIdentity.ino !== historyIdentity.rootIdentity.ino) {
    throw new Error("state and history databases must share one canonical fenced root");
  }
  const lease = acquireStateRootLease(stateIdentity.root, "shared");
  try {
    lease.assertCurrent();
    assertCanonicalStateDatabaseIdentity(stateIdentity);
    assertCanonicalStateDatabaseIdentity(historyIdentity);
    if (inspectStateV4OpenAdmission(stateIdentity.root, lease.pinnedRoot) === "restore_consumed") {
      throw new Error("compatibility observation is blocked by incomplete consumed restore");
    }
    const result = verifyCompatibilityRuntimeLocked({ ...input,
      stateDatabase: join(lease.pinnedRoot, basename(stateIdentity.path)),
      historyDatabase: join(lease.pinnedRoot, basename(historyIdentity.path)) });
    lease.assertCurrent();
    assertCanonicalStateDatabaseIdentity(stateIdentity);
    assertCanonicalStateDatabaseIdentity(historyIdentity);
    return result;
  } finally { lease.release(); }
}

function verifyCompatibilityRuntimeLocked(input: {
  stateDatabase: string;
  historyDatabase: string;
  faultInjector?: (point: "after_snapshot") => void;
}): CompatibilityRuntimeObservation {
  const statePath = resolve(input.stateDatabase);
  const historyPath = resolve(input.historyDatabase);
  if (statePath === historyPath) throw new Error("state and history databases must be distinct");
  const state = new Database(statePath, { readonly: true, fileMustExist: true });
  let history: Database.Database | null = null;
  try {
    history = new Database(historyPath, { readonly: true, fileMustExist: true });
    state.pragma("query_only = ON");
    history.pragma("query_only = ON");
    const stateVersion = userVersion(state);
    const historyVersion = userVersion(history);
    if ((stateVersion !== V3 && stateVersion !== V4) || historyVersion !== V2) {
      throw new Error(`unsupported compatibility schema pair: state=${stateVersion}, history=${historyVersion}`);
    }

    const stateDataVersion = Number(state.pragma("data_version", { simple: true }));
    const historyDataVersion = Number(history.pragma("data_version", { simple: true }));
    state.exec("BEGIN");
    history.exec("BEGIN");
    let reviewSchema: CompatibilityRuntimeObservation["reviewSchema"];
    let stateProfile: CompatibilityRuntimeObservation["stateProfile"];
    if (stateVersion === V3) {
      verifyV3State(state);
      reviewSchema = "routing_v5";
      stateProfile = "v3_routing_v5";
    } else if (tableExists(state, "runtime_schema_capabilities")) {
      verifyRoutingV5State(state, V4);
      assertReviewV3SchemaSignature(state);
      reviewSchema = "review_v3";
      stateProfile = "v4_review_v3";
    } else {
      verifyV4State(state);
      reviewSchema = "routing_v5";
      stateProfile = "v4_routing_v5";
    }
    input.faultInjector?.("after_snapshot");
    verifyHistoryV2Schema(history, true);
    const graphSchema = graphSchemaState(state);
    if (stateVersion === V3 && graphSchema !== "absent") {
      throw new Error("graph v4 schema cannot be present on state v3");
    }
    const legacySchemaSha256 = legacyStateSchemaSha256(state);
    if (!LEGACY_STATE_PROFILE_SHA256[stateProfile].some((expected) => legacySchemaSha256 === expected)) {
      throw new Error(`legacy state schema profile mismatch: ${stateProfile}`);
    }
    assertExactIndex(state, "idx_worktree_handoffs_task", ["task_id", "id"]);
    assertNoAdditiveUniqueIndexes(state);
    if (String(state.pragma("integrity_check", { simple: true })) !== "ok" ||
        String(history.pragma("integrity_check", { simple: true })) !== "ok") {
      throw new Error("compatibility database integrity check failed");
    }
    if ((state.pragma("foreign_key_check") as unknown[]).length > 0 ||
        (history.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("compatibility database foreign-key check failed");
    }
    const stateSchemaSha256 = schemaSha256(state);
    const historySchemaSha256 = schemaSha256(history);
    state.exec("COMMIT");
    history.exec("COMMIT");
    if (Number(state.pragma("data_version", { simple: true })) !== stateDataVersion ||
        Number(history.pragma("data_version", { simple: true })) !== historyDataVersion) {
      throw new Error("compatibility database changed while it was being verified");
    }
    if (GRAPH_EXECUTION_MODE !== "disabled") {
      throw new Error("compatibility runtime requires graph execution to be disabled");
    }
    return {
      schemaVersion: "compatibility-runtime-open-observation/v1",
      stateVersion,
      historyVersion: 2,
      openMode: "read_only",
      graphExecution: GRAPH_EXECUTION_MODE,
      graphSchema,
      reviewSchema,
      stateProfile,
      stateSchemaSha256,
      historySchemaSha256,
      integrity: { state: "ok", history: "ok", foreignKeys: "ok" },
    };
  } catch (error) {
    if (state.inTransaction) state.exec("ROLLBACK");
    if (history?.inTransaction) history.exec("ROLLBACK");
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`compatibility schema verification failed: ${detail}`, { cause: error });
  } finally {
    history?.close();
    state.close();
  }
}

function verifyInitialClaudeHealth(state: Database.Database): void {
  const claude = state.prepare(`SELECT agent,health,retry_at,failure_count,
    attempt_claimed,capability_verified,updated_at
    FROM runtime_provider_health WHERE agent='claude'`).get();
  if (!isDeepStrictEqual(claude, {
    agent: "claude",
    health: "probing",
    retry_at: null,
    failure_count: 0,
    attempt_claimed: 0,
    capability_verified: 0,
    updated_at: 0,
  })) {
    throw new Error("v3 Claude provider health initialization mismatch");
  }
}

function migrateStateToV3(
  db: Database.Database,
  faultInjector?: (point: MigrationFaultPoint) => void,
): void {
  const migrate = db.transaction(() => {
    if (userVersion(db) !== V2) {
      throw new Error(`state schema changed before v3 migration: ${userVersion(db)}`);
    }
    const blocked = blockingV3Tables(db);
    if (blocked.length > 0) throw new MigrationBlockedError(blocked);

    db.exec(`
      ALTER TABLE runtime_provider_health RENAME TO runtime_provider_health_v2;
      CREATE TABLE runtime_provider_health (
        agent TEXT PRIMARY KEY CHECK (agent IN ('grok', 'claude', 'codex')),
        health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
        retry_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
        capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      INSERT INTO runtime_provider_health
        (agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at)
      SELECT agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at
        FROM runtime_provider_health_v2;
      INSERT INTO runtime_provider_health
        (agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at)
      VALUES ('claude','probing',NULL,0,0,0,0);
      DROP TABLE runtime_provider_health_v2;

      DROP INDEX runtime_review_attempts_lane;
      DROP TABLE runtime_review_lane_attempts;
      DROP INDEX runtime_review_lanes_status;
      DROP TABLE runtime_review_lanes;
      DROP TABLE runtime_review_barriers;

      CREATE TABLE runtime_review_barriers (
        review_id TEXT PRIMARY KEY,
        stage_id TEXT NOT NULL,
        artifact BLOB NOT NULL,
        artifact_hash TEXT NOT NULL,
        approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
        idempotency_key TEXT NOT NULL,
        run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_REVIEW_SET')),
        created_at INTEGER NOT NULL,
        project TEXT,
        requester TEXT CHECK (requester IS NULL OR requester IN ('grok', 'codex')),
        source_fingerprint TEXT,
        changed_files INTEGER NOT NULL DEFAULT 0 CHECK (changed_files >= 0)
      );
      CREATE TABLE runtime_review_lanes (
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'claude', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
        model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'glm-5.3', 'gpt-5.6-sol')),
        effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh', 'max')),
        policy_version TEXT NOT NULL CHECK (policy_version = 'routing-v5'),
        reasons TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL,
        degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        result TEXT,
        error TEXT,
        terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role)
      );
      CREATE INDEX runtime_review_lanes_status ON runtime_review_lanes(review_id, status);
      CREATE TABLE runtime_review_lane_attempts (
        review_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'claude', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (review_id, agent, role, attempt_ordinal),
        FOREIGN KEY (review_id, agent, role)
          REFERENCES runtime_review_lanes(review_id, agent, role) ON DELETE CASCADE
      );
      CREATE INDEX runtime_review_attempts_lane
        ON runtime_review_lane_attempts(review_id, agent, role, attempt_ordinal);

      DROP TABLE worktree_leases;
      CREATE TABLE worktree_leases (
        worktree_path TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        holder TEXT NOT NULL CHECK (holder IN ('grok', 'codex')),
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        authority_policy TEXT NOT NULL DEFAULT 'routing-v5'
          CHECK (authority_policy = 'routing-v5')
      );
      PRAGMA user_version = 3;
    `);
    verifyV3State(db);
    verifyInitialClaudeHealth(db);
    faultInjector?.("before_v3_commit");
  });
  migrate.exclusive();
}

function migrateStateToV4(
  db: Database.Database,
  input: {
    graphDdl: string;
    expectedLegacyManifestSha256: string;
    progress: VerifiedProgressBundle;
    faultInjector?: (point: MigrationFaultPoint) => void;
  },
): void {
  const migrate = db.transaction(() => {
    const fromVersion = userVersion(db);
    if (manifestSha256(legacyTableManifest(db)) !== input.expectedLegacyManifestSha256) {
      throw new Error("legacy write epoch changed after backup");
    }
    if (fromVersion === V3) {
      verifyV3State(db);
      db.exec(`
        ALTER TABLE runtime_review_barriers
          ADD COLUMN launch_authority_version INTEGER NOT NULL DEFAULT 1
            CHECK (launch_authority_version IN (1, 2));
        ${V4_LAUNCH_AUTHORITY_TRIGGERS}
      `);
    } else if (fromVersion === V4 && graphSchemaState(db) === "absent") {
      verifyRoutingV5State(db, V4);
      if (tableExists(db, "runtime_schema_capabilities")) assertReviewV3SchemaSignature(db);
      else verifyLaunchAuthorityV4(db);
    } else {
      throw new Error(`state schema changed before graph v4 migration: ${fromVersion}`);
    }
    db.exec(input.graphDdl);
    input.faultInjector?.("after_v4_ddl");
    db.pragma("user_version = 4");
    const insertEvent = db.prepare(`INSERT INTO plan_progress_events
      (plan_id,sequence_no,event_id,start_sha256,previous_event_sha256,
       effective_plan_sha256,event_json,event_sha256,created_at)
      VALUES (@planId,@sequence,@eventId,@startSha256,@previousEventSha256,
       @effectivePlanSha256,@eventJson,@eventSha256,@createdAt)`);
    const insertOutbox = db.prepare(`INSERT INTO plan_progress_outbox
      (event_id,projection_payload_json,published_at,terminal_reason)
      VALUES (?, ?, NULL, NULL)`);
    for (const event of input.progress.events) {
      const createdAt = Date.parse(event.recordedAt);
      if (!Number.isSafeInteger(createdAt)) throw new Error("pre-v4 event timestamp is invalid");
      insertEvent.run({ ...event, createdAt });
      insertOutbox.run(event.eventId, event.eventJson);
      input.faultInjector?.("during_v4_progress_import");
    }
    verifyV4State(db);
    if ((db.prepare("SELECT COUNT(*) FROM plan_progress_events").pluck().get() as number) !==
        input.progress.events.length) throw new Error("pre-v4 progress import count mismatch");
    input.faultInjector?.("before_v4_commit");
  });
  migrate.exclusive();
}

const assertTerminalStateV4RecoveryGeneration = (
  stateRoot: string,
  stateDatabasePath: string,
  state: Database.Database,
): void => {
  const descriptor = readActiveStateV4GuardDescriptor(stateRoot);
  if (!descriptor) {
    assertNoInterruptedRetirement(stateRoot);
    if (existsSync(resolve(stateRoot, "migration-v4"))) {
      throw new Error("current state-v4 migration has no active recovery authority");
    }
    return;
  }
  withStateV4ArtifactLeases([descriptor.backupPath, descriptor.tableDigestManifestPath], () => {
    const currentDatabaseIdentity = databaseIdentity(stateDatabasePath);
    if (currentDatabaseIdentity !== descriptor.databaseIdentity ||
        sha256Bytes(canonicalJson({ databaseIdentity: currentDatabaseIdentity,
          tableDigestManifestSha256: descriptor.tableDigestManifestSha256 })) !== descriptor.writeEpoch) {
      throw new Error("terminal state-v4 database identity changed from its recovery generation");
    }
    if (sha256Bytes(readFileSync(descriptor.backupPath)) !== descriptor.backupSha256 ||
        ["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${descriptor.backupPath}${suffix}`))) {
      throw new Error("terminal state-v4 backup bytes or sidecars changed");
    }
    const manifestBytes = readFileSync(descriptor.tableDigestManifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes) as LegacyTableManifest;
    if (`${canonicalJson(manifest)}\n` !== manifestBytes ||
        manifestSha256(manifest) !== descriptor.tableDigestManifestSha256 ||
        manifestSha256(legacyTableManifest(state, manifest)) !== descriptor.tableDigestManifestSha256) {
      throw new Error("terminal state-v4 manifest bytes or preserved rows changed");
    }
    const records = new StateV4RestoreGuard({ journalPath: descriptor.guardPath,
      databaseIdentity: descriptor.databaseIdentity, backupSha256: descriptor.backupSha256,
      tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
      writeEpoch: descriptor.writeEpoch }).readAndVerify();
    if (records.length !== 1 || records[0]?.event !== "backup_created") {
      throw new Error("terminal state-v4 recovery guard is no longer pristine");
    }
  });
};

export class MigrationCoordinator {
  private readonly options: MigrationCoordinatorOptions;
  private readonly stateIdentity: CanonicalStateDatabaseIdentity;
  private readonly historyIdentity: CanonicalStateDatabaseIdentity;

  constructor(options: MigrationCoordinatorOptions) {
    this.stateIdentity = canonicalStateDatabaseIdentity(options.stateDatabase);
    this.historyIdentity = canonicalStateDatabaseIdentity(options.historyDatabase);
    const stateDatabase = this.stateIdentity.path;
    const historyDatabase = this.historyIdentity.path;
    if (stateDatabase === historyDatabase) throw new Error("state and history databases must be distinct");
    if (this.stateIdentity.root !== this.historyIdentity.root ||
        this.stateIdentity.rootIdentity.dev !== this.historyIdentity.rootIdentity.dev ||
        this.stateIdentity.rootIdentity.ino !== this.historyIdentity.rootIdentity.ino) {
      throw new Error("state and history databases must share one canonical fenced root");
    }
    this.options = { stateDatabase, historyDatabase,
      ...(options.backupDirectory ? { backupDirectory: resolve(options.backupDirectory) } : {}),
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
      repositoryRoot: resolve(options.repositoryRoot ?? process.cwd()),
      progressPackagePath: options.progressPackagePath ?? "docs/hybrid-flow-v1-r2",
    };
  }

  private acquireExclusiveStateRoot(): StateRootLease {
    assertCanonicalStateDatabaseIdentity(this.stateIdentity);
    assertCanonicalStateDatabaseIdentity(this.historyIdentity);
    const lease = acquireStateRootLease(this.stateIdentity.root, "exclusive");
    try {
      assertCanonicalStateDatabaseIdentity(this.stateIdentity);
      assertCanonicalStateDatabaseIdentity(this.historyIdentity);
      return lease;
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  extendReviewV3SchemaOffline(): void {
    const lease = this.acquireExclusiveStateRoot();
    try {
      this.extendReviewV3SchemaOfflineLocked(join(lease.pinnedRoot, basename(this.options.stateDatabase)));
      lease.assertCurrent();
    } finally { lease.release(); }
  }

  private extendReviewV3SchemaOfflineLocked(stateDatabase: string): void {
    const state = new Database(stateDatabase);
    state.pragma("foreign_keys = ON");
    try {
      acquireExclusiveOwnership(state);
      extendReviewV3SchemaOffline(state, this.options.faultInjector);
    } finally {
      state.close();
    }
  }

  migrateToV2(): MigrationResult {
    const lease = this.acquireExclusiveStateRoot();
    try {
      const result = this.migrateToV2Locked(
        join(lease.pinnedRoot, basename(this.options.stateDatabase)),
        join(lease.pinnedRoot, basename(this.options.historyDatabase)),
      );
      lease.assertCurrent();
      return result;
    } finally { lease.release(); }
  }

  private migrateToV2Locked(stateDatabase: string, historyDatabase: string): MigrationResult {
    const temporaryBackup = this.options.backupDirectory === undefined;
    const backupRoot = this.options.backupDirectory ??
      mkdtempSync(join(dirname(stateDatabase), "rollback-v1-"));
    if (!temporaryBackup) prepareRollbackBundle({ bundleDirectory: backupRoot });
    const stateBackup = join(backupRoot, "collaboration-v1.db");
    const historyBackup = join(backupRoot, "history-v1.db");
    let state: Database.Database | null = null;
    let history: Database.Database | null = null;
    let backupsReady = false;
    let migrationSucceeded = false;
    try {
      state = new Database(stateDatabase);
      history = new Database(historyDatabase);
      state.pragma("foreign_keys = ON");
      history.pragma("foreign_keys = ON");
      acquireExclusiveOwnership(state);
      acquireExclusiveOwnership(history);

      const stateVersion = effectiveV1Version(state, "state");
      const historyVersion = effectiveV1Version(history, "history");
      if (stateVersion === V2 && historyVersion === V2) {
        verifyV2(state, history);
        return { status: "already_current", fromVersion: 2, toVersion: 2 };
      }
      if (stateVersion !== V1 || historyVersion !== V1) {
        throw new Error(`unsupported or partial schema versions: state=${stateVersion}, history=${historyVersion}`);
      }

      const blocked = blockingTables(state);
      if (blocked.length > 0) throw new MigrationBlockedError(blocked);
      assertSafePendingTools(history);

      const expectedHistory = historyDigest(history, true);
      createConsistentBackup(state, stateBackup);
      createConsistentBackup(history, historyBackup);
      finalizeRollbackBundle(backupRoot);
      backupsReady = true;
      migrateState(state);
      this.options.faultInjector?.("after_state_commit");
      migrateHistory(history);
      this.options.faultInjector?.("after_history_commit");
      verifyV2(state, history);
      const actualHistory = historyDigest(history, false);
      if (!isDeepStrictEqual(actualHistory, expectedHistory)) {
        throw new Error("history preservation digest mismatch");
      }
      migrationSucceeded = true;
      return { status: "migrated", fromVersion: 1, toVersion: 2, rollbackBundle: backupRoot };
    } catch (error) {
      state?.close();
      history?.close();
      state = null;
      history = null;
      if (backupsReady) {
        try {
          restoreV1Bundle({
            bundleDirectory: backupRoot,
            stateDatabase,
            historyDatabase,
          });
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], "v2 migration failed and compensating restore failed");
        }
      }
      throw error;
    } finally {
      state?.close();
      history?.close();
      if (temporaryBackup && !migrationSucceeded) rmSync(backupRoot, { recursive: true, force: true });
    }
  }

  migrateToV3(): MigrationResult {
    const lease = this.acquireExclusiveStateRoot();
    try {
      const result = this.migrateToV3Locked(
        join(lease.pinnedRoot, basename(this.options.stateDatabase)),
        join(lease.pinnedRoot, basename(this.options.historyDatabase)),
      );
      lease.assertCurrent();
      return result;
    } finally { lease.release(); }
  }

  private migrateToV3Locked(stateDatabase: string, historyDatabase: string): MigrationResult {
    const state = new Database(stateDatabase);
    const history = new Database(historyDatabase, { readonly: true });
    state.pragma("foreign_keys = ON");
    try {
      const stateVersion = userVersion(state);
      const historyVersion = userVersion(history);
      if (stateVersion === V3 && historyVersion === V2) {
        verifyV3State(state);
        return { status: "already_current", fromVersion: 3, toVersion: 3 };
      }
      if (stateVersion !== V2 || historyVersion !== V2) {
        throw new Error(`unsupported or partial schema versions: state=${stateVersion}, history=${historyVersion}`);
      }

      migrateStateToV3(state, this.options.faultInjector);
      verifyV3State(state);
      if (userVersion(history) !== V2) throw new Error("v3 migration changed the history schema marker");
      return { status: "migrated", fromVersion: 2, toVersion: 3 };
    } finally {
      state.close();
      history.close();
    }
  }

  migrateToV4(): MigrationResult {
    const lease = this.acquireExclusiveStateRoot();
    try {
      const result = this.migrateToV4Locked(
        join(lease.pinnedRoot, basename(this.options.stateDatabase)),
        join(lease.pinnedRoot, basename(this.options.historyDatabase)),
      );
      lease.assertCurrent();
      return result;
    } finally {
      lease.release();
    }
  }

  private migrateToV4Locked(stateDatabase: string, historyDatabase: string): MigrationResult {
    const repositoryRoot = this.options.repositoryRoot!;
    const progressPackagePath = this.options.progressPackagePath!;
    const graphDdl = loadGraphV4Ddl(repositoryRoot);
    const progress = loadVerifiedProgressBundle(repositoryRoot, progressPackagePath, this.options.faultInjector);
    const state = new Database(stateDatabase);
    const history = new Database(historyDatabase, { readonly: true });
    state.pragma("foreign_keys = ON");
    try {
      const stateVersion = userVersion(state);
      const historyVersion = userVersion(history);
      if (stateVersion === V4 && historyVersion === V2) {
        if (graphSchemaState(state) === "complete_disabled") {
          verifyV4State(state);
          assertTerminalStateV4RecoveryGeneration(realpathSync(dirname(stateDatabase)), stateDatabase, state);
          return { status: "already_current", fromVersion: 4, toVersion: 4 };
        }
        verifyRoutingV5State(state, V4);
        if (tableExists(state, "runtime_schema_capabilities")) assertReviewV3SchemaSignature(state);
        else verifyLaunchAuthorityV4(state);
      }
      if ((stateVersion !== V3 && stateVersion !== V4) || historyVersion !== V2) {
        throw new Error(`unsupported or partial schema versions: state=${stateVersion}, history=${historyVersion}`);
      }
      if (stateVersion === V3 && retiredStateV4Descriptors(realpathSync(dirname(stateDatabase))).length > 0) {
        throw new Error("re-migration after consumed state-v4 recovery requires operator reconciliation");
      }
      verifyHistoryV2Schema(history, true);
      if (stateVersion === V3) {
        verifyV3State(state);
        assertKnownV3LegacyObjects(state);
      }
      const legacyManifest = legacyTableManifest(state);
      const tableDigestManifestSha256 = manifestSha256(legacyManifest);
      const identity = databaseIdentity(stateDatabase);
      const writeEpoch = sha256Bytes(canonicalJson({
        databaseIdentity: identity,
        tableDigestManifestSha256,
      }));
      const migrationLayout = ensureStateV4MigrationLayout(dirname(stateDatabase));
      const backupRoot = this.options.backupDirectory ?? migrationLayout.backupDirectory;
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const reusable = reusableActiveMigrationArtifacts({
        layout: migrationLayout,
        backupRoot,
        databaseIdentity: identity,
        tableDigestManifestSha256,
        writeEpoch,
      });
      const stateSchemaSha256 = schemaSha256(state);
      const adoptable = reusable ? undefined : adoptablePreDescriptorArtifacts({
        backupRoot,
        tableDigestManifestSha256,
        stateSchemaSha256,
      });
      if (adoptable) this.options.faultInjector?.("after_v4_orphan_adoption");
      const backupPath = reusable?.backupPath ?? adoptable?.backupPath ??
        resolve(backupRoot, `collaboration-v${stateVersion}-${randomUUID()}.db`);
      const tableDigestManifestPath = reusable?.tableDigestManifestPath ??
        adoptable?.tableDigestManifestPath ?? `${backupPath}.manifest.json`;
      if (!reusable && !adoptable) {
        writeFileSync(tableDigestManifestPath, `${canonicalJson(legacyManifest)}\n`, { mode: 0o600, flag: "wx" });
        fsyncPath(tableDigestManifestPath);
        fsyncPath(dirname(tableDigestManifestPath));
        createConsistentBackup(state, backupPath);
        fsyncPath(backupPath);
        fsyncPath(dirname(backupPath));
      }
      if (!reusable) this.options.faultInjector?.("before_v4_descriptor");
      let backupSha256 = "";
      let guardPath = "";
      withStateV4ArtifactLeases([backupPath, tableDigestManifestPath], () => {
        const sidecars = ["-wal", "-shm", "-journal"].filter((suffix) => existsSync(`${backupPath}${suffix}`));
        if (sidecars.length > 0) throw new Error("state-v4 backup has unbound SQLite sidecar state");
        const manifestBytes = readFileSync(tableDigestManifestPath, "utf8");
        const signedManifest = JSON.parse(manifestBytes) as LegacyTableManifest;
        if (`${canonicalJson(signedManifest)}\n` !== manifestBytes ||
            manifestSha256(signedManifest) !== tableDigestManifestSha256) {
          throw new Error("state-v4 manifest changed before descriptor publication");
        }
        const backupSha256BeforeVerification = sha256Bytes(readFileSync(backupPath));
        const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
        try {
          backup.pragma("query_only = ON");
          if (String(backup.pragma("integrity_check", { simple: true })) !== "ok" ||
              (backup.pragma("foreign_key_check") as unknown[]).length > 0 ||
              userVersion(backup) !== stateVersion ||
              manifestSha256(legacyTableManifest(backup)) !== tableDigestManifestSha256 ||
              schemaSha256(backup) !== stateSchemaSha256) {
            throw new Error("state-v4 backup verification failed");
          }
        } finally { backup.close(); }
        const verifiedBackupSha256 = sha256Bytes(readFileSync(backupPath));
        if (backupSha256BeforeVerification !== verifiedBackupSha256 ||
            ["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${backupPath}${suffix}`))) {
          throw new Error("state-v4 backup bytes changed during verification");
        }
        backupSha256 = reusable?.backupSha256 ?? verifiedBackupSha256;
        if (reusable && backupSha256 !== verifiedBackupSha256) {
          throw new Error("active state-v4 backup hash changed before descriptor reuse");
        }
        guardPath = reusable?.guardPath ??
          resolve(migrationLayout.guardDirectory, `state-v4-${backupSha256}.jsonl`);
        if (!reusable) {
          const descriptor = activeStateV4GuardDescriptor({ databaseIdentity: identity, backupSha256,
            tableDigestManifestSha256, writeEpoch, backupPath, tableDigestManifestPath, guardPath });
          writeActiveStateV4GuardDescriptor(migrationLayout.root, descriptor);
          const published = readActiveStateV4GuardDescriptor(migrationLayout.root);
          if (published?.descriptorSha256 !== descriptor.descriptorSha256 ||
              sha256Bytes(readFileSync(backupPath)) !== backupSha256 ||
              manifestSha256(JSON.parse(readFileSync(tableDigestManifestPath, "utf8"))) !== tableDigestManifestSha256) {
            throw new Error("published state-v4 descriptor does not bind exact artifact bytes");
          }
          this.options.faultInjector?.("after_v4_backup");
        }
      });
      if (!reusable?.guardExists) {
        const guard = new StateV4RestoreGuard({
          journalPath: guardPath,
          databaseIdentity: identity,
          backupSha256,
          tableDigestManifestSha256,
          writeEpoch,
          ...(this.options.faultInjector ? { faultInjector: this.options.faultInjector } : {}),
        });
        guard.createBackupRecord(Date.now());
        this.options.faultInjector?.("after_v4_guard");
      }
      migrateStateToV4(state, {
        graphDdl,
        expectedLegacyManifestSha256: tableDigestManifestSha256,
        progress,
        ...(this.options.faultInjector ? { faultInjector: this.options.faultInjector } : {}),
      });
      verifyV4State(state);
      if (userVersion(history) !== V2) throw new Error("v4 migration changed the history schema marker");
      this.options.faultInjector?.("before_v4_terminal_artifact_reread");
      assertTerminalStateV4RecoveryGeneration(migrationLayout.root, stateDatabase, state);
      return {
        status: "migrated",
        fromVersion: stateVersion,
        toVersion: 4,
        backupPath,
        backupSha256,
        guardPath,
        databaseIdentity: identity,
        tableDigestManifestSha256,
        tableDigestManifestPath,
        writeEpoch,
        importedProgressEvents: progress.events.length,
        lastProgressEventSha256: progress.lastEventSha256,
      };
    } finally {
      state.close();
      history.close();
    }
  }
}

export function doctorV1Databases(
  state: Database.Database,
  history: Database.Database,
): V1DoctorResult {
    const stateVersion = effectiveV1Version(state, "state");
    const historyVersion = effectiveV1Version(history, "history");
    const mutableCounts = Object.fromEntries(MUTABLE_RUNTIME_TABLES.map((table) => [
      table,
      tableExists(state, table)
        ? Number(state.prepare(`SELECT COUNT(*) FROM "${table}"`).pluck().get())
        : 0,
    ]));
    const blockers: string[] = [];
    if (stateVersion !== V1) blockers.push(`state_version:${stateVersion}`);
    if (historyVersion !== V1) blockers.push(`history_version:${historyVersion}`);
    if (String(state.pragma("integrity_check", { simple: true })) !== "ok") blockers.push("state_integrity");
    if (String(history.pragma("integrity_check", { simple: true })) !== "ok") blockers.push("history_integrity");
    if ((state.pragma("foreign_key_check") as unknown[]).length > 0) blockers.push("state_foreign_keys");
    if ((history.pragma("foreign_key_check") as unknown[]).length > 0) blockers.push("history_foreign_keys");
    for (const [table, count] of Object.entries(mutableCounts)) {
      if (count > 0) blockers.push(`mutable:${table}:${count}`);
    }
    return { readyForMigration: blockers.length === 0, stateVersion, historyVersion, blockers, mutableCounts };
}

export function doctorV1(input: { stateDatabase: string; historyDatabase: string }): V1DoctorResult {
  const stateLease = openStateDatabaseLease(resolve(input.stateDatabase), "offline_observation", {
    readonly: true,
    fileMustExist: true,
  });
  const history = new Database(resolve(input.historyDatabase), { readonly: true });
  try { return doctorV1Databases(stateLease.database, history); }
  finally {
    history.close();
    stateLease.close();
  }
}
