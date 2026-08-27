import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { redactSensitive } from "../security/redaction.js";
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
  | "before_v3_commit";

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
  | { status: "already_current"; fromVersion: 3; toVersion: 3 };

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

export function initializeCurrentExecutionSchema(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  try {
    const existing = EXECUTION_TABLES.filter((table) => tableExists(db, table));
    if (existing.length === EXECUTION_TABLES.length) return;
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
      PRAGMA user_version = 3;
      `);
    });
    initialize.immediate();
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
  for (const table of ["sources", "history_rows", "pending_tools"]) requireAgentConstraint(history, table, true);
  if (!tableExists(history, "memory_source_health")) throw new Error("missing v2 memory source health table");
  const historyRowsSql = (history.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='history_rows'",
  ).get() as { sql: string } | undefined)?.sql ?? "";
  for (const namespace of ["grok_native", "codex_native", "claude_legacy", "collaboration_shared"]) {
    if (!historyRowsSql.includes(`'${namespace}'`)) {
      throw new Error(`invalid v2 history namespace constraint: ${namespace}`);
    }
  }
  if ((state.pragma("foreign_key_check") as unknown[]).length > 0 ||
      (history.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new Error("v2 foreign-key verification failed");
  }
  for (const [db, indexes] of [[state, ["runs_due", "collaboration_outbox_pending", "runtime_review_lanes_status", "runtime_review_attempts_lane", "idx_worktree_handoffs_task"]],
    [history, ["history_rows_project"]]] as const) {
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

function verifyV3State(state: Database.Database): void {
  if (userVersion(state) !== V3) throw new Error("v3 state schema marker mismatch");

  const healthSql = schemaSql(state, "runtime_provider_health");
  const barrierSql = schemaSql(state, "runtime_review_barriers");
  const laneSql = schemaSql(state, "runtime_review_lanes");
  const attemptSql = schemaSql(state, "runtime_review_lane_attempts");
  const leaseSql = schemaSql(state, "worktree_leases");
  for (const provider of ["grok", "claude", "codex"]) {
    if (!healthSql.includes(`'${provider}'`) ||
        !laneSql.includes(`'${provider}'`) ||
        !attemptSql.includes(`'${provider}'`)) {
      throw new Error(`invalid v3 review provider constraint: ${provider}`);
    }
  }
  for (const model of ["grok-4.6", "glm-5.3", "gpt-5.6-sol"]) {
    if (!laneSql.includes(`'${model}'`)) throw new Error(`invalid v3 review model constraint: ${model}`);
  }
  for (const effort of ["high", "xhigh", "max"]) {
    if (!laneSql.includes(`'${effort}'`)) throw new Error(`invalid v3 review effort constraint: ${effort}`);
  }
  if (!barrierSql.includes("'DEGRADED_REVIEW_SET'") ||
      !laneSql.includes("policy_version = 'routing-v5'") ||
      !barrierSql.includes("requester IN ('grok', 'codex')") ||
      !leaseSql.includes("holder IN ('grok', 'codex')") ||
      leaseSql.includes("'claude'") ||
      !leaseSql.includes("DEFAULT 'routing-v5'")) {
    throw new Error("v3 routing-v5 schema constraints are incomplete");
  }
  const claude = state.prepare("SELECT agent FROM runtime_provider_health WHERE agent='claude'").get();
  if (!isDeepStrictEqual(claude, { agent: "claude" })) {
    throw new Error("v3 Claude provider health row is missing");
  }
  if ((state.pragma("foreign_key_check") as unknown[]).length > 0) {
    throw new Error("v3 state foreign-key verification failed");
  }
  for (const index of [
    "runs_due",
    "collaboration_outbox_pending",
    "runtime_review_lanes_status",
    "runtime_review_attempts_lane",
  ]) {
    if (state.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index) === undefined) {
      throw new Error(`missing v3 index: ${index}`);
    }
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
