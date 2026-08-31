import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { redactSensitive } from "../security/redaction.js";
import { GRAPH_EXECUTION_MODE } from "../store/state-layout.js";
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
  | ReviewV3FaultPoint;

export interface MigrationCoordinatorOptions {
  stateDatabase: string;
  historyDatabase: string;
  faultInjector?: (point: MigrationFaultPoint) => void;
  backupDirectory?: string;
}

export type MigrationResult =
  | { status: "migrated"; fromVersion: 1; toVersion: 2; rollbackBundle: string }
  | { status: "already_current"; fromVersion: 2; toVersion: 2 }
  | { status: "migrated"; fromVersion: 2; toVersion: 3 }
  | { status: "already_current"; fromVersion: 3; toVersion: 3 }
  | { status: "migrated"; fromVersion: 3; toVersion: 4 }
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

const GRAPH_V4_TABLES = [
  "agent_attempt_usage", "agent_event_archive_members", "agent_event_archives",
  "agent_event_payloads", "agent_events", "agent_sessions", "agent_usage_coverage",
  "flow_mcp_idempotency", "graph_budget_reservations", "graph_budget_settlements",
  "graph_edge_evaluations", "graph_edges", "graph_flows", "graph_node_admission_intents",
  "graph_node_admissions", "graph_node_attempts", "graph_node_input_bindings",
  "graph_node_results", "graph_nodes", "plan_progress_events", "plan_progress_outbox",
  "session_memory_revisions",
] as const;
const GRAPH_V4_REQUIRED_INDEXES = [
  "agent_events_cursor", "agent_sessions_parent", "agent_usage_attempt", "archive_flow_range",
  "flow_mcp_idempotency_status", "graph_attempts_latest", "graph_budget_flow",
  "graph_edges_source", "graph_edges_target", "graph_intents_pending", "graph_nodes_ready",
  "plan_progress_outbox_pending",
] as const;
const GRAPH_V4_TABLE_SCHEMA_SHA256 = "2b3a0f52fdbfe2e6a9ac4d2ace77423888c3d6c50787950bdaf834f978357751";
const GRAPH_V4_REQUIRED_INDEX_SHA256 = "1c38876a1730a8fc9b00d756bc81158d5bdd894099ef3b67d9470030b1539ba5";
const LEGACY_STATE_PROFILE_SHA256 = {
  v3_routing_v5: "7a29baaff38b71f25e6670429398944b34b708f9f661ea4512eddacfa2b5d585",
  v4_routing_v5: "d9843b1c811c1fddfe916b51fb6c0e90f18d4c53185f78fc2b068c2862b69bb0",
  v4_review_v3: "761f81590bfb897a81be8fc42ae2b133d11cfe45d96d031460fc392645938ed3",
} as const;
const HISTORY_V2_SCHEMA_SHA256 = "58b2d0fd246bbe2ee62969dded0f2a6dcd242340ae90f6a9293abed4c2dbe2fd";

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

export function initializeCurrentExecutionSchema(
  path: string,
  options: { faultInjector?: (point: string) => void } = {},
): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  try {
    const existing = EXECUTION_TABLES.filter((table) => tableExists(db, table));
    if (existing.length === EXECUTION_TABLES.length) {
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
      PRAGMA user_version = 4;
      `);
    });
    initialize.immediate();
    extendReviewV3SchemaOffline(db, options.faultInjector);
  } finally {
    db.close();
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
    if (exactSchema !== HISTORY_V2_SCHEMA_SHA256) {
      throw new Error("history v2 schema profile mismatch");
    }
  }
}

function graphSchemaState(state: Database.Database): "absent" | "complete_disabled" {
  const tables = normalizedSchemaRows(state, GRAPH_V4_TABLES);
  const requiredIndexes = normalizedSchemaRows(state, GRAPH_V4_REQUIRED_INDEXES);
  const graphTableSet = new Set<string>(GRAPH_V4_TABLES);
  const graphNamedObjects = normalizedSchemaRows(state).filter((row) =>
    row.name.startsWith("graph_") || graphTableSet.has(row.tblName));
  if (tables.length === 0 && requiredIndexes.length === 0 && graphNamedObjects.length === 0) return "absent";
  if (tables.length !== GRAPH_V4_TABLES.length ||
      schemaRowsSha256(tables) !== GRAPH_V4_TABLE_SCHEMA_SHA256 ||
      requiredIndexes.length !== GRAPH_V4_REQUIRED_INDEXES.length ||
      schemaRowsSha256(requiredIndexes) !== GRAPH_V4_REQUIRED_INDEX_SHA256 ||
      graphNamedObjects.some((row) => row.type === "trigger" || row.type === "view")) {
    throw new Error("partial or altered graph v4 schema");
  }
  return "complete_disabled";
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

function verifyV4State(state: Database.Database): void {
  verifyRoutingV5State(state, V4);
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

export function verifyCompatibilityRuntime(input: {
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
    if (legacyStateSchemaSha256(state) !== LEGACY_STATE_PROFILE_SHA256[stateProfile]) {
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
  faultInjector?: (point: MigrationFaultPoint) => void,
): void {
  const migrate = db.transaction(() => {
    if (userVersion(db) !== V3) {
      throw new Error(`state schema changed before v4 migration: ${userVersion(db)}`);
    }
    verifyV3State(db);
    db.exec(`
      ALTER TABLE runtime_review_barriers
        ADD COLUMN launch_authority_version INTEGER NOT NULL DEFAULT 1
          CHECK (launch_authority_version IN (1, 2));
      ${V4_LAUNCH_AUTHORITY_TRIGGERS}
      PRAGMA user_version = 4;
    `);
    verifyV4State(db);
    faultInjector?.("before_v3_commit");
  });
  migrate.exclusive();
}

export class MigrationCoordinator {
  private readonly options: MigrationCoordinatorOptions;

  constructor(options: MigrationCoordinatorOptions) {
    const stateDatabase = resolve(options.stateDatabase);
    const historyDatabase = resolve(options.historyDatabase);
    if (stateDatabase === historyDatabase) throw new Error("state and history databases must be distinct");
    this.options = { stateDatabase, historyDatabase,
      ...(options.backupDirectory ? { backupDirectory: resolve(options.backupDirectory) } : {}),
      ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}) };
  }

  extendReviewV3SchemaOffline(): void {
    const state = new Database(this.options.stateDatabase);
    state.pragma("foreign_keys = ON");
    try {
      acquireExclusiveOwnership(state);
      extendReviewV3SchemaOffline(state, this.options.faultInjector);
    } finally {
      state.close();
    }
  }

  migrateToV2(): MigrationResult {
    const temporaryBackup = this.options.backupDirectory === undefined;
    const backupRoot = this.options.backupDirectory ??
      mkdtempSync(join(dirname(this.options.stateDatabase), "rollback-v1-"));
    if (!temporaryBackup) prepareRollbackBundle({ bundleDirectory: backupRoot });
    const stateBackup = join(backupRoot, "collaboration-v1.db");
    const historyBackup = join(backupRoot, "history-v1.db");
    let state: Database.Database | null = null;
    let history: Database.Database | null = null;
    let backupsReady = false;
    let migrationSucceeded = false;
    try {
      state = new Database(this.options.stateDatabase);
      history = new Database(this.options.historyDatabase);
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
            stateDatabase: this.options.stateDatabase,
            historyDatabase: this.options.historyDatabase,
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
    const state = new Database(this.options.stateDatabase);
    const history = new Database(this.options.historyDatabase, { readonly: true });
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
    const state = new Database(this.options.stateDatabase);
    const history = new Database(this.options.historyDatabase, { readonly: true });
    state.pragma("foreign_keys = ON");
    try {
      const stateVersion = userVersion(state);
      const historyVersion = userVersion(history);
      if (stateVersion === V4 && historyVersion === V2) {
        verifyV4State(state);
        return { status: "already_current", fromVersion: 4, toVersion: 4 };
      }
      if (stateVersion !== V3 || historyVersion !== V2) {
        throw new Error(`unsupported or partial schema versions: state=${stateVersion}, history=${historyVersion}`);
      }

      migrateStateToV4(state, this.options.faultInjector);
      verifyV4State(state);
      if (userVersion(history) !== V2) throw new Error("v4 migration changed the history schema marker");
      return { status: "migrated", fromVersion: 3, toVersion: 4 };
    } finally {
      state.close();
      history.close();
    }
  }
}

export function doctorV1(input: { stateDatabase: string; historyDatabase: string }): V1DoctorResult {
  const state = new Database(resolve(input.stateDatabase), { readonly: true });
  const history = new Database(resolve(input.historyDatabase), { readonly: true });
  try {
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
  } finally {
    state.close();
    history.close();
  }
}
