import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  MigrationBlockedError,
  MigrationCoordinator,
} from "../src/migration/coordinator.js";
import { AuthorizedV4TestCoordinator } from "./helpers/authorized-v4-coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";

const roots: string[] = [];

const databases = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-migration-v3-"));
  roots.push(root);
  return {
    state: join(root, "state.db"),
    history: join(root, "history.db"),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedV2(statePath: string, historyPath: string): void {
  const state = new Database(statePath);
  state.exec(`
    PRAGMA foreign_keys = ON;
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
      workflow_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE collaboration_dispatch_outbox (
      dispatch_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES collaboration_runs(workflow_id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL, published_at INTEGER, terminal_reason TEXT
    );
    CREATE INDEX collaboration_outbox_pending
      ON collaboration_dispatch_outbox(published_at, dispatch_id);
    CREATE TABLE runtime_review_barriers (
      review_id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, artifact BLOB NOT NULL,
      artifact_hash TEXT NOT NULL, approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
      idempotency_key TEXT NOT NULL,
      run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_SINGLE_PROVIDER')),
      created_at INTEGER NOT NULL, project TEXT,
      requester TEXT CHECK (requester IS NULL OR requester IN ('grok', 'codex')),
      source_fingerprint TEXT, changed_files INTEGER NOT NULL DEFAULT 0 CHECK (changed_files >= 0)
    );
    CREATE TABLE runtime_review_lanes (
      review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
      agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
      role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
      model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
      effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
      policy_version TEXT NOT NULL CHECK (policy_version = 'routing-v4'),
      reasons TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL, degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
      result TEXT, error TEXT, terminal_at INTEGER,
      PRIMARY KEY (review_id, agent, role)
    );
    CREATE INDEX runtime_review_lanes_status ON runtime_review_lanes(review_id, status);
    CREATE TABLE runtime_review_lane_attempts (
      review_id TEXT NOT NULL, agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
      role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
      attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), created_at INTEGER NOT NULL,
      PRIMARY KEY (review_id, agent, role, attempt_ordinal),
      FOREIGN KEY (review_id, agent, role)
        REFERENCES runtime_review_lanes(review_id, agent, role) ON DELETE CASCADE
    );
    CREATE INDEX runtime_review_attempts_lane
      ON runtime_review_lane_attempts(review_id, agent, role, attempt_ordinal);
    CREATE TABLE runtime_provider_health (
      agent TEXT PRIMARY KEY CHECK (agent IN ('grok', 'codex')),
      health TEXT NOT NULL CHECK (health IN ('healthy', 'unavailable', 'probing', 'disabled')),
      retry_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
      attempt_claimed INTEGER NOT NULL DEFAULT 0 CHECK (attempt_claimed IN (0, 1)),
      capability_verified INTEGER NOT NULL DEFAULT 0 CHECK (capability_verified IN (0, 1)),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE approval_grants (
      reference TEXT NOT NULL, project TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
      expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL CHECK (max_uses > 0),
      used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
      PRIMARY KEY (reference, project, scope)
    );
    CREATE TABLE approval_consumptions (
      consumer_key TEXT PRIMARY KEY, reference TEXT NOT NULL, project TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('workspace-read', 'workspace-write', 'external')),
      consumed_at INTEGER NOT NULL
    );
    CREATE TABLE worktree_leases (
      worktree_path TEXT PRIMARY KEY, task_id TEXT NOT NULL, lease_id TEXT NOT NULL,
      holder TEXT NOT NULL CHECK (holder IN ('grok', 'codex')),
      fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      authority_policy TEXT NOT NULL DEFAULT 'routing-v4'
        CHECK (authority_policy IN ('routing-v3', 'routing-v4'))
    );
    CREATE TABLE worktree_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX idx_worktree_handoffs_task ON worktree_handoffs(task_id, id);
    PRAGMA user_version = 2;
  `);
  state.close();

  const history = new Database(historyPath);
  history.exec(`
    CREATE TABLE sources (
      project TEXT NOT NULL, source_path TEXT NOT NULL,
      agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
      checkpoint_offset INTEGER NOT NULL, checkpoint_line INTEGER NOT NULL,
      prefix_hash TEXT NOT NULL, session_id TEXT,
      PRIMARY KEY (project, source_path)
    );
    CREATE TABLE history_rows (
      project TEXT NOT NULL, source_path TEXT NOT NULL, record_key TEXT NOT NULL,
      source_agent TEXT NOT NULL CHECK (source_agent IN ('grok', 'codex', 'claude_legacy')),
      namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native', 'claude_legacy', 'collaboration_shared')),
      kind TEXT NOT NULL CHECK (kind IN ('memory', 'message', 'tool_summary')),
      session_id TEXT, role TEXT NOT NULL CHECK (role IN ('assistant', 'memory', 'user')),
      content TEXT NOT NULL, source_line INTEGER NOT NULL, timestamp TEXT,
      content_hash TEXT NOT NULL, trust TEXT NOT NULL CHECK (trust = 'untrusted'),
      PRIMARY KEY (project, source_path, record_key)
    );
    CREATE INDEX history_rows_project
      ON history_rows(project, source_agent, source_path, source_line);
    CREATE TABLE pending_tools (
      project TEXT NOT NULL, source_path TEXT NOT NULL, call_id TEXT NOT NULL,
      agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
      name TEXT NOT NULL, session_id TEXT, source_line INTEGER NOT NULL,
      timestamp TEXT, record_key TEXT NOT NULL,
      PRIMARY KEY (project, source_path, call_id)
    );
    CREATE TABLE history_issues (
      project TEXT NOT NULL, source_path TEXT NOT NULL, code TEXT NOT NULL,
      source_line INTEGER NOT NULL DEFAULT -1, details TEXT,
      PRIMARY KEY (project, source_path, code, source_line)
    );
    CREATE TABLE memory_source_health (
      project TEXT NOT NULL,
      namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native')),
      status TEXT NOT NULL CHECK (status IN ('projected', 'unavailable', 'no_project_section')),
      source_path TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (project, namespace)
    );
    INSERT INTO sources VALUES ('/repo', '/repo/legacy.jsonl', 'claude_legacy', 7, 1, 'abc', 'legacy-session');
    PRAGMA user_version = 2;
  `);
  history.close();
}

const guardedRows = {
  runs: `INSERT INTO runs
    (id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
    VALUES ('run-1','run-1','planning',1,'completed',1,1)`,
  collaboration_runs: `INSERT INTO collaboration_runs VALUES ('workflow-1','{}',1,1)`,
  collaboration_dispatch_outbox: `INSERT INTO collaboration_dispatch_outbox
    VALUES ('dispatch-1','missing-workflow','{}',1,'terminal')`,
  runtime_review_barriers: `INSERT INTO runtime_review_barriers
    (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,run_state,created_at)
    VALUES ('review-1','review',X'01','abc','workspace-read','review-1','FULL_CROSS_PROVIDER',1)`,
  runtime_review_lanes: `INSERT INTO runtime_review_lanes
    (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,idempotency_key,prompt,degraded)
    VALUES ('missing-review','grok','auditor','completed','grok-4.6','high','routing-v4','[]','session-1','lane-1','audit',0)`,
  runtime_review_lane_attempts: `INSERT INTO runtime_review_lane_attempts
    VALUES ('missing-review','grok','auditor',0,'missing-run',1)`,
  worktree_leases: `INSERT INTO worktree_leases
    VALUES ('/repo','task-1','lease-1','codex',1,1,'routing-v4')`,
} as const;

function schemaSnapshot(path: string): unknown {
  const db = new Database(path, { readonly: true });
  try {
    return {
      version: Number(db.pragma("user_version", { simple: true })),
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      counts: Object.keys(guardedRows).map((table) => ({
        table,
        count: Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()),
      })),
    };
  } finally {
    db.close();
  }
}

describe("routing-v5 state schema v3 migration", () => {
  it.each(Object.entries(guardedRows))(
    "blocks before DDL when guarded table %s contains even a terminal row",
    (table, statement) => {
      const paths = databases();
      seedV2(paths.state, paths.history);
      const db = new Database(paths.state);
      db.pragma("foreign_keys = OFF");
      db.exec(statement);
      db.close();
      const before = schemaSnapshot(paths.state);

      let thrown: unknown;
      try {
        new MigrationCoordinator({
          stateDatabase: paths.state,
          historyDatabase: paths.history,
        }).migrateToV3();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MigrationBlockedError);
      expect((thrown as MigrationBlockedError).blockingTables).toContain(table);
      expect(schemaSnapshot(paths.state)).toEqual(before);
    },
  );

  it("migrates an empty state atomically, preserves health and history, and survives reopen", () => {
    const paths = databases();
    seedV2(paths.state, paths.history);
    const state = new Database(paths.state);
    state.prepare(`INSERT INTO runtime_provider_health
      VALUES ('grok','healthy',NULL,0,0,1,11)`).run();
    state.prepare(`INSERT INTO runtime_provider_health
      VALUES ('codex','unavailable',99,2,0,0,12)`).run();
    state.close();

    expect(new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV3()).toMatchObject({ status: "migrated", fromVersion: 2, toVersion: 3 });

    const migrated = new Database(paths.state, { readonly: true });
    expect(Number(migrated.pragma("user_version", { simple: true }))).toBe(3);
    expect(migrated.prepare(`SELECT agent,health,retry_at,failure_count,
      attempt_claimed,capability_verified,updated_at
      FROM runtime_provider_health ORDER BY agent`).all()).toEqual([
      { agent: "claude", health: "probing", retry_at: null, failure_count: 0,
        attempt_claimed: 0, capability_verified: 0, updated_at: 0 },
      { agent: "codex", health: "unavailable", retry_at: 99, failure_count: 2,
        attempt_claimed: 0, capability_verified: 0, updated_at: 12 },
      { agent: "grok", health: "healthy", retry_at: null, failure_count: 0,
        attempt_claimed: 0, capability_verified: 1, updated_at: 11 },
    ]);
    const laneSchema = (migrated.prepare(`SELECT sql FROM sqlite_master
      WHERE type='table' AND name='runtime_review_lanes'`).get() as { sql: string }).sql;
    expect(laneSchema).toContain("'claude'");
    expect(laneSchema).toContain("'routing-v5'");
    migrated.close();

    const history = new Database(paths.history, { readonly: true });
    expect(Number(history.pragma("user_version", { simple: true }))).toBe(2);
    expect(history.prepare("SELECT agent,session_id FROM sources").all()).toEqual([
      { agent: "claude_legacy", session_id: "legacy-session" },
    ]);
    history.close();

    const providers = new ProviderHealthStore(paths.state, { cooldownMs: 1_000 });
    expect(providers.snapshot().claude).toMatchObject({ health: "probing" });
    expect(providers.recordSuccess("claude", 42)).toMatchObject({
      health: "healthy",
      capabilityVerified: true,
      updatedAt: 42,
    });
    providers.close();
    expect(() => new RunGateUnitOfWork(paths.state)).toThrow(/current routing-v5 schema/i);
    expect(new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV3()).toEqual({ status: "already_current", fromVersion: 3, toVersion: 3 });
    const v4Coordinator = new AuthorizedV4TestCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    });
    expect(v4Coordinator.migrateToV4()).toMatchObject({ status: "migrated", fromVersion: 3, toVersion: 4 });
    const reviews = new RunGateUnitOfWork(paths.state);
    reviews.close();
    const reopenedProviders = new ProviderHealthStore(paths.state, { cooldownMs: 1_000 });
    expect(reopenedProviders.snapshot().claude).toMatchObject({
      health: "healthy",
      capabilityVerified: true,
      updatedAt: 42,
    });
    reopenedProviders.close();
  });

  it("rolls back a pre-commit fault and permits a clean retry after reopen", () => {
    const paths = databases();
    seedV2(paths.state, paths.history);
    const state = new Database(paths.state);
    state.prepare(`INSERT INTO runtime_provider_health
      VALUES ('grok','healthy',NULL,0,0,1,11)`).run();
    state.prepare(`INSERT INTO runtime_provider_health
      VALUES ('codex','probing',NULL,0,0,0,12)`).run();
    state.close();
    const before = schemaSnapshot(paths.state);

    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v3_commit") throw new Error("injected v3 pre-commit fault");
      },
    }).migrateToV3()).toThrow(/injected v3 pre-commit fault/i);
    expect(schemaSnapshot(paths.state)).toEqual(before);

    const reopened = new Database(paths.state, { readonly: true });
    expect(reopened.pragma("quick_check", { simple: true })).toBe("ok");
    expect(Number(reopened.pragma("user_version", { simple: true }))).toBe(2);
    reopened.close();

    expect(new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV3()).toMatchObject({ status: "migrated", fromVersion: 2, toVersion: 3 });
    const providers = new ProviderHealthStore(paths.state, { cooldownMs: 1_000 });
    expect(providers.snapshot().claude.health).toBe("probing");
    providers.close();
  });

  it("treats every valid mutable Claude health state as already-current schema", () => {
    const paths = databases();
    seedV2(paths.state, paths.history);
    const coordinator = new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    });
    expect(coordinator.migrateToV3()).toMatchObject({ status: "migrated" });
    const states = [
      { health: "probing", retryAt: null, failureCount: 1, attemptClaimed: 1, verified: 0, updatedAt: 10 },
      { health: "healthy", retryAt: null, failureCount: 0, attemptClaimed: 0, verified: 1, updatedAt: 20 },
      { health: "unavailable", retryAt: 99, failureCount: 2, attemptClaimed: 0, verified: 1, updatedAt: 30 },
      { health: "disabled", retryAt: null, failureCount: 0, attemptClaimed: 0, verified: 0, updatedAt: 40 },
    ] as const;
    for (const state of states) {
      const database = new Database(paths.state);
      database.prepare(`UPDATE runtime_provider_health
        SET health=?,retry_at=?,failure_count=?,attempt_claimed=?,capability_verified=?,updated_at=?
        WHERE agent='claude'`).run(
        state.health,
        state.retryAt,
        state.failureCount,
        state.attemptClaimed,
        state.verified,
        state.updatedAt,
      );
      database.close();
      expect(coordinator.migrateToV3()).toEqual({
        status: "already_current",
        fromVersion: 3,
        toVersion: 3,
      });
      const reopened = new Database(paths.state, { readonly: true });
      expect(reopened.prepare(`SELECT health,retry_at AS retryAt,failure_count AS failureCount,
        attempt_claimed AS attemptClaimed,capability_verified AS verified,updated_at AS updatedAt
        FROM runtime_provider_health WHERE agent='claude'`).get()).toEqual(state);
      reopened.close();
    }
  });
});
