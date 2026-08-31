import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  doctorV1,
  MigrationCoordinator,
  prepareRollbackBundle,
  restoreV1Bundle,
  type MigrationFaultPoint,
  verifyBundle,
} from "../src/migration/coordinator.js";

const roots: string[] = [];

interface FixturePaths {
  root: string;
  stateDatabase: string;
  historyDatabase: string;
}

interface LogicalSnapshot {
  userVersion: number;
  objects: Array<{ type: string; name: string; table: string; sql: string | null }>;
  rows: Record<string, unknown[]>;
  foreignKeyErrors: unknown[];
}

interface HistoryDump {
  sources: Array<Record<string, unknown>>;
  history_rows: Array<Record<string, unknown>>;
  pending_tools: Array<Record<string, unknown>>;
  history_issues: Array<Record<string, unknown>>;
}

const normalize = (value: unknown): unknown => {
  if (Buffer.isBuffer(value)) return { blobHex: value.toString("hex") };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
};

function logicalSnapshot(path: string): LogicalSnapshot {
  const db = new Database(path, { readonly: true });
  try {
    const objects = db.prepare(`
      SELECT type, name, tbl_name AS "table", sql
        FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name
    `).all() as LogicalSnapshot["objects"];
    const tables = objects.filter((object) => object.type === "table").map((object) => object.name);
    const rows = Object.fromEntries(tables.map((table) => {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      return [table, normalize(db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all()) as unknown[]];
    }));
    return {
      userVersion: Number(db.pragma("user_version", { simple: true })),
      objects,
      rows,
      foreignKeyErrors: normalize(db.pragma("foreign_key_check")) as unknown[],
    };
  } finally {
    db.close();
  }
}

function makeFixture(): FixturePaths {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-v2-migration-"));
  roots.push(root);
  const paths = { root, stateDatabase: join(root, "collaboration.db"), historyDatabase: join(root, "history.db") };
  createV1State(paths.stateDatabase);
  createV1History(paths.historyDatabase);
  return paths;
}

function createV1State(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE runtime_provider_health (
        agent TEXT PRIMARY KEY CHECK (agent IN ('claude', 'codex')),
        health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
        retry_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
        capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
        priority INTEGER NOT NULL, status TEXT NOT NULL, artifact_hash TEXT, approval_scope TEXT,
        created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
        lease_token TEXT, lease_expires_at INTEGER, worker_id TEXT, launched INTEGER NOT NULL DEFAULT 0,
        launch_info TEXT, result TEXT, cancel_reason TEXT, payload TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0, depends_on_run_id TEXT
      );
      CREATE INDEX runs_due ON runs(status, next_attempt_at, priority, created_at);
      CREATE TABLE collaboration_runs (
        workflow_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE collaboration_dispatch_outbox (
        dispatch_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES collaboration_runs(workflow_id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL, published_at INTEGER
      );
      CREATE INDEX collaboration_outbox_pending ON collaboration_dispatch_outbox(published_at, dispatch_id);
      CREATE TABLE runtime_review_barriers (
        review_id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, artifact BLOB NOT NULL,
        artifact_hash TEXT NOT NULL, approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
        idempotency_key TEXT NOT NULL,
        run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_SINGLE_PROVIDER')),
        created_at INTEGER NOT NULL, project TEXT,
        requester TEXT CHECK (requester IS NULL OR requester IN ('claude', 'codex')),
        source_fingerprint TEXT
      );
      CREATE TABLE runtime_review_lanes (
        review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
        agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
        role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
        model TEXT NOT NULL, effort TEXT NOT NULL CHECK (effort = 'xhigh'),
        session_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL, degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
        result TEXT, error TEXT, terminal_at INTEGER,
        PRIMARY KEY (review_id, agent, role)
      );
      CREATE INDEX runtime_review_lanes_status ON runtime_review_lanes(review_id, status);
      CREATE TABLE worktree_leases (
        worktree_path TEXT PRIMARY KEY, task_id TEXT NOT NULL, lease_id TEXT NOT NULL,
        holder TEXT NOT NULL CHECK (holder IN ('claude', 'codex')),
        fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE worktree_handoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX idx_worktree_handoffs_task ON worktree_handoffs(task_id, id);
      CREATE TABLE approval_grants (
        reference TEXT NOT NULL, project TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
        expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL CHECK (max_uses > 0),
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
        PRIMARY KEY (reference, project, scope)
      );
    `);
    db.prepare(`INSERT INTO runtime_provider_health
      (agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run("claude", "unavailable", 100, 3, 0, 0, 90);
    db.prepare(`INSERT INTO runtime_provider_health
      (agent,health,retry_at,failure_count,attempt_claimed,capability_verified,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run("codex", "healthy", null, 0, 0, 1, 91);
  } finally {
    db.close();
  }
}

function createV1History(path: string): void {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE sources (
        project TEXT NOT NULL, source_path TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
        checkpoint_offset INTEGER NOT NULL, checkpoint_line INTEGER NOT NULL,
        prefix_hash TEXT NOT NULL, session_id TEXT,
        PRIMARY KEY (project, source_path)
      );
      CREATE TABLE history_rows (
        project TEXT NOT NULL, source_path TEXT NOT NULL, record_key TEXT NOT NULL,
        source_agent TEXT NOT NULL CHECK (source_agent IN ('claude', 'codex')),
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'message', 'tool_summary')),
        session_id TEXT, role TEXT NOT NULL CHECK (role IN ('assistant', 'memory', 'user')),
        content TEXT NOT NULL, source_line INTEGER NOT NULL, timestamp TEXT,
        content_hash TEXT NOT NULL, trust TEXT NOT NULL CHECK (trust = 'untrusted'),
        PRIMARY KEY (project, source_path, record_key)
      );
      CREATE INDEX history_rows_project ON history_rows(project, source_agent, source_path, source_line);
      CREATE TABLE pending_tools (
        project TEXT NOT NULL, source_path TEXT NOT NULL, call_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
        name TEXT NOT NULL, session_id TEXT, source_line INTEGER NOT NULL,
        timestamp TEXT, record_key TEXT NOT NULL,
        PRIMARY KEY (project, source_path, call_id)
      );
      CREATE TABLE history_issues (
        project TEXT NOT NULL, source_path TEXT NOT NULL, code TEXT NOT NULL,
        source_line INTEGER NOT NULL DEFAULT -1, details TEXT,
        PRIMARY KEY (project, source_path, code, source_line)
      );
    `);
    const source = db.prepare(`INSERT INTO sources
      (project,source_path,agent,checkpoint_offset,checkpoint_line,prefix_hash,session_id)
      VALUES (?,?,?,?,?,?,?)`);
    source.run("/repo", "/history/claude.jsonl", "claude", 101, 7, "claude-prefix-hash", "claude-session");
    source.run("/repo", "/history/codex.jsonl", "codex", 202, 8, "codex-prefix-hash", "codex-session");

    const row = db.prepare(`INSERT INTO history_rows
      (project,source_path,record_key,source_agent,kind,session_id,role,content,source_line,timestamp,content_hash,trust)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    row.run("/repo", "/history/claude.jsonl", "message:c1", "claude", "message", "claude-session", "assistant",
      "exact Claude visible content", 3, "2026-08-20T10:00:00Z", "claude-content-hash", "untrusted");
    row.run("/repo", "/history/codex.jsonl", "memory:k1", "codex", "memory", "codex-session", "memory",
      "exact Codex memory content", 4, "2026-08-20T11:00:00Z", "codex-content-hash", "untrusted");

    const pending = db.prepare(`INSERT INTO pending_tools
      (project,source_path,call_id,agent,name,session_id,source_line,timestamp,record_key)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    pending.run("/repo", "/history/claude.jsonl", "call-c", "claude", "read_file", "claude-session", 5,
      "2026-08-20T10:01:00Z", "tool:c");
    pending.run("/repo", "/history/codex.jsonl", "call-k", "codex", "grep", "codex-session", 6,
      "2026-08-20T11:01:00Z", "tool:k");

    const issue = db.prepare(`INSERT INTO history_issues
      (project,source_path,code,source_line,details) VALUES (?,?,?,?,?)`);
    issue.run("/repo", "/history/claude.jsonl", "malformed_json", 9, '{"reason":"exact issue details"}');
    issue.run("/repo", "/history/codex.jsonl", "partial_line", -1, null);
  } finally {
    db.close();
  }
}

function historyRows(path: string): HistoryDump {
  const db = new Database(path, { readonly: true });
  try {
    const rows = (table: string) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    return {
      sources: rows("sources"),
      history_rows: rows("history_rows"),
      pending_tools: rows("pending_tools"),
      history_issues: rows("history_issues"),
    };
  } finally {
    db.close();
  }
}

function tableSql(db: Database.Database, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`missing table ${table}`);
  return row.sql;
}

function expectActiveConstraint(sql: string, legacyAllowed = false): void {
  expect(sql).toContain("'grok'");
  expect(sql).toContain("'codex'");
  if (legacyAllowed) expect(sql).toContain("'claude_legacy'");
  expect(sql).not.toMatch(/'claude'(?!_legacy)/);
}

type SeedBlocker = (db: Database.Database) => void;

const mutableEntities: Array<{ table: string; seed: SeedBlocker }> = [
  { table: "runs", seed: (db) => db.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,launched,attempt_count)
      VALUES ('run-1','key-1','planning',1,'queued',1,1,0,0)`).run() },
  { table: "collaboration_runs", seed: (db) => db.prepare(`INSERT INTO collaboration_runs
      (workflow_id,state_json,version,updated_at) VALUES ('workflow-1','{}',1,1)`).run() },
  { table: "collaboration_dispatch_outbox", seed: (db) => {
    db.prepare(`INSERT INTO collaboration_runs (workflow_id,state_json,version,updated_at)
      VALUES ('workflow-parent','{}',1,1)`).run();
    db.prepare(`INSERT INTO collaboration_dispatch_outbox
      (dispatch_id,workflow_id,payload_json,published_at) VALUES ('dispatch-1','workflow-parent','{}',NULL)`).run();
  } },
  { table: "runtime_review_barriers", seed: (db) => db.prepare(`INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,run_state,created_at,requester)
      VALUES ('review-1','code_review',X'01','hash','workspace-read','review-key','FULL_CROSS_PROVIDER',1,'codex')`).run() },
  { table: "runtime_review_lanes", seed: (db) => {
    db.prepare(`INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,run_state,created_at,requester)
      VALUES ('review-parent','code_review',X'01','hash','workspace-read','review-parent-key','FULL_CROSS_PROVIDER',1,'codex')`).run();
    db.prepare(`INSERT INTO runtime_review_lanes
      (review_id,agent,role,status,model,effort,session_id,idempotency_key,prompt,degraded)
      VALUES ('review-parent','claude','auditor','queued','claude-opus-5','xhigh','session-1','lane-key','audit',0)`).run();
  } },
  { table: "worktree_leases", seed: (db) => db.prepare(`INSERT INTO worktree_leases
      (worktree_path,task_id,lease_id,holder,fencing_token,expires_at)
      VALUES ('/repo','task-1','lease-1','claude',1,999)`).run() },
  { table: "worktree_handoffs", seed: (db) => db.prepare(`INSERT INTO worktree_handoffs
      (task_id,recorded_at,payload) VALUES ('task-1',1,'{"from":"claude","to":"codex"}')`).run() },
  { table: "approval_grants", seed: (db) => db.prepare(`INSERT INTO approval_grants
      (reference,project,scope,expires_at,max_uses,used_count)
      VALUES ('approval-1','/repo','workspace-write',999,1,0)`).run() },
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline v1 to v2 migration coordinator", () => {
  it("provides a read-only v1 doctor and retains a caller-owned rollback bundle", () => {
    const paths = makeFixture();
    expect(doctorV1(paths)).toMatchObject({
      readyForMigration: true,
      stateVersion: 1,
      historyVersion: 1,
      blockers: [],
    });
    const bundle = join(paths.root, "rollback-v1");
    const result = new MigrationCoordinator({ ...paths, backupDirectory: bundle }).migrateToV2();
    expect(result).toMatchObject({ status: "migrated", rollbackBundle: bundle });
    expect(existsSync(join(bundle, "collaboration-v1.db"))).toBe(true);
    expect(existsSync(join(bundle, "history-v1.db"))).toBe(true);
    expect(verifyBundle(bundle).manifest.format).toBe("agent-collab-rollback/v1");
    expect(doctorV1(paths)).toMatchObject({
      readyForMigration: false,
      blockers: expect.arrayContaining(["state_version:2", "history_version:2"]),
    });
  });

  it("prepares artifacts and a verified database manifest before the first schema mutation", () => {
    const paths = makeFixture();
    const artifact = join(paths.root, "previous-service.unit");
    writeFileSync(artifact, "v1 service artifact\n", { mode: 0o600 });
    const bundle = join(paths.root, "rollback-v1");
    prepareRollbackBundle({
      bundleDirectory: bundle,
      artifacts: [{ name: "service/agent-collab.service", sourcePath: artifact }],
    });

    expect(() => new MigrationCoordinator({
      ...paths,
      backupDirectory: bundle,
      faultInjector: (point) => {
        if (point !== "after_state_commit") return;
        const verified = verifyBundle(bundle);
        expect(verified.manifest.files.map((file) => file.path)).toEqual([
          "artifacts/service/agent-collab.service",
          "collaboration-v1.db",
          "history-v1.db",
        ]);
        throw new Error("injected:manifest-precedes-mutation");
      },
    }).migrateToV2()).toThrow("injected:manifest-precedes-mutation");

    expect(doctorV1(paths)).toMatchObject({ readyForMigration: true, blockers: [] });
    expect(readFileSync(join(bundle, "artifacts/service/agent-collab.service"), "utf8"))
      .toBe("v1 service artifact\n");
  });

  it("restores both verified v1 databases and passes the deterministic v1 doctor", () => {
    const paths = makeFixture();
    const before = {
      state: logicalSnapshot(paths.stateDatabase),
      history: logicalSnapshot(paths.historyDatabase),
    };
    const bundle = join(paths.root, "rollback-v1");
    new MigrationCoordinator({ ...paths, backupDirectory: bundle }).migrateToV2();

    expect(restoreV1Bundle({
      bundleDirectory: bundle,
      stateDatabase: paths.stateDatabase,
      historyDatabase: paths.historyDatabase,
    })).toMatchObject({ restored: true });
    expect({
      state: logicalSnapshot(paths.stateDatabase),
      history: logicalSnapshot(paths.historyDatabase),
    }).toEqual(before);
    expect(doctorV1(paths)).toMatchObject({ readyForMigration: true, blockers: [] });
  });

  it("rejects a tampered bundle before either live database is replaced", () => {
    const paths = makeFixture();
    const bundle = join(paths.root, "rollback-v1");
    new MigrationCoordinator({ ...paths, backupDirectory: bundle }).migrateToV2();
    const beforeRestore = {
      state: logicalSnapshot(paths.stateDatabase),
      history: logicalSnapshot(paths.historyDatabase),
    };
    writeFileSync(join(bundle, "history-v1.db"), Buffer.concat([
      readFileSync(join(bundle, "history-v1.db")),
      Buffer.from("tampered"),
    ]));

    expect(() => verifyBundle(bundle)).toThrow(/hash mismatch/i);
    expect(() => restoreV1Bundle({
      bundleDirectory: bundle,
      stateDatabase: paths.stateDatabase,
      historyDatabase: paths.historyDatabase,
    })).toThrow(/hash mismatch/i);
    expect({
      state: logicalSnapshot(paths.stateDatabase),
      history: logicalSnapshot(paths.historyDatabase),
    }).toEqual(beforeRestore);
  });

  it("compensates both live databases when the second replacement cannot start", () => {
    const paths = makeFixture();
    const bundle = join(paths.root, "rollback-v1");
    new MigrationCoordinator({ ...paths, backupDirectory: bundle }).migrateToV2();
    const beforeRestore = {
      state: logicalSnapshot(paths.stateDatabase),
      history: logicalSnapshot(paths.historyDatabase),
    };

    expect(() => restoreV1Bundle({
      bundleDirectory: bundle,
      stateDatabase: paths.stateDatabase,
      historyDatabase: paths.historyDatabase,
      faultInjector: () => { throw new Error("injected:after-state-replace"); },
    })).toThrow("injected:after-state-replace");
    expect({
      state: logicalSnapshot(paths.stateDatabase),
      history: logicalSnapshot(paths.historyDatabase),
    }).toEqual(beforeRestore);
  });

  it("rejects unsafe pending tool metadata without changing either database", () => {
    const paths = makeFixture();
    const history = new Database(paths.historyDatabase);
    try {
      history.prepare("UPDATE pending_tools SET source_path=?, name=? WHERE call_id=?")
        .run("/history/claude.jsonl", "read_file TOKEN=secret", "call-c");
    } finally { history.close(); }
    const before = { state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) };

    expect(() => new MigrationCoordinator(paths).migrateToV2()).toThrow(/unsafe pending tool/i);
    expect({ state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) }).toEqual(before);
  });

  it("rejects non-canonical pending tool paths without changing either database", () => {
    const paths = makeFixture();
    const history = new Database(paths.historyDatabase);
    try {
      history.prepare("UPDATE pending_tools SET source_path=? WHERE call_id=?")
        .run("relative/../history.jsonl", "call-c");
    } finally { history.close(); }
    const before = { state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) };
    expect(() => new MigrationCoordinator(paths).migrateToV2()).toThrow(/unsafe pending tool/i);
    expect({ state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) }).toEqual(before);
  });

  it("migrates zero-runtime state and exact legacy history once", () => {
    const paths = makeFixture();
    const beforeHistory = historyRows(paths.historyDatabase);
    const coordinator = new MigrationCoordinator(paths);

    expect(coordinator.migrateToV2()).toMatchObject({ status: "migrated", fromVersion: 1, toVersion: 2 });

    const state = new Database(paths.stateDatabase);
    const history = new Database(paths.historyDatabase);
    try {
      expect(state.pragma("user_version", { simple: true })).toBe(2);
      expect(history.pragma("user_version", { simple: true })).toBe(2);
      expect(state.prepare(`SELECT agent,health,retry_at,failure_count,attempt_claimed,capability_verified
        FROM runtime_provider_health ORDER BY agent`).all()).toEqual([
        { agent: "codex", health: "probing", retry_at: null, failure_count: 0, attempt_claimed: 0, capability_verified: 0 },
        { agent: "grok", health: "probing", retry_at: null, failure_count: 0, attempt_claimed: 0, capability_verified: 0 },
      ]);

      for (const table of ["runtime_provider_health", "runtime_review_barriers", "runtime_review_lanes", "worktree_leases"]) {
        expectActiveConstraint(tableSql(state, table));
      }
      for (const table of ["sources", "history_rows", "pending_tools"]) {
        expectActiveConstraint(tableSql(history, table), true);
      }

      const afterHistory = historyRows(paths.historyDatabase);
      expect(afterHistory.sources).toEqual(beforeHistory.sources.map((row) => ({
        ...row, agent: row.agent === "claude" ? "claude_legacy" : row.agent,
      })));
      expect(afterHistory.history_rows).toEqual(beforeHistory.history_rows.map((row) => ({
        ...row,
        source_agent: row.source_agent === "claude" ? "claude_legacy" : row.source_agent,
        namespace: row.source_agent === "claude" ? "claude_legacy" : `${String(row.source_agent)}_native`,
      })));
      expect(afterHistory.pending_tools).toEqual(beforeHistory.pending_tools.map((row) => ({
        ...row, agent: row.agent === "claude" ? "claude_legacy" : row.agent,
      })));
      expect(afterHistory.history_issues).toEqual(beforeHistory.history_issues);
      expect(state.pragma("foreign_key_check")).toEqual([]);
      expect(history.pragma("foreign_key_check")).toEqual([]);
    } finally {
      state.close();
      history.close();
    }

    const once = { state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) };
    expect(new MigrationCoordinator(paths).migrateToV2()).toMatchObject({
      status: "already_current", fromVersion: 2, toVersion: 2,
    });
    expect({ state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) }).toEqual(once);
  });

  it.each(mutableEntities)("aborts unchanged when $table is nonempty", ({ table, seed }) => {
    const paths = makeFixture();
    const db = new Database(paths.stateDatabase);
    try { seed(db); } finally { db.close(); }
    const before = { state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) };

    let thrown: unknown;
    try {
      new MigrationCoordinator(paths).migrateToV2();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "MUTABLE_RUNTIME_NOT_EMPTY",
      blockingTables: expect.arrayContaining([table]),
    });
    expect({ state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) }).toEqual(before);
    expect(logicalSnapshot(paths.stateDatabase).userVersion).toBe(1);
    expect(logicalSnapshot(paths.historyDatabase).userVersion).toBe(1);
  });

  it.each(["after_state_commit", "after_history_commit"] as const)(
    "restores both databases after injected failure at %s",
    (failurePoint) => {
      const paths = makeFixture();
      const before = { state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) };
      const coordinator = new MigrationCoordinator({
        ...paths,
        faultInjector: (point: MigrationFaultPoint) => {
          if (point === failurePoint) throw new Error(`injected:${failurePoint}`);
        },
      });

      expect(() => coordinator.migrateToV2()).toThrow(`injected:${failurePoint}`);
      expect({ state: logicalSnapshot(paths.stateDatabase), history: logicalSnapshot(paths.historyDatabase) }).toEqual(before);

      expect(new MigrationCoordinator(paths).migrateToV2()).toMatchObject({
        status: "migrated", fromVersion: 1, toVersion: 2,
      });
    },
  );
});
