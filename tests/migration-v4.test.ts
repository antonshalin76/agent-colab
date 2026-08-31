import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializeCurrentExecutionSchema,
  MigrationCoordinator,
} from "../src/migration/coordinator.js";

const roots: string[] = [];

const databases = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-migration-v4-"));
  roots.push(root);
  return {
    state: join(root, "state.db"),
    history: join(root, "history.db"),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedHistoryV2(path: string): void {
  const history = new Database(path);
  history.exec(`
    CREATE TABLE sources (
      project TEXT NOT NULL, source_path TEXT NOT NULL,
      agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
      checkpoint_offset INTEGER NOT NULL, checkpoint_line INTEGER NOT NULL,
      prefix_hash TEXT NOT NULL, session_id TEXT,
      PRIMARY KEY (project, source_path)
    );
    INSERT INTO sources VALUES ('/repo', '/repo/codex.jsonl', 'codex', 7, 1, 'abc', 'session');
    PRAGMA user_version = 2;
  `);
  history.close();
}

function seedStateV3(path: string): void {
  initializeCurrentExecutionSchema(path);
  const state = new Database(path);
  const columns = state.prepare("PRAGMA table_info(runtime_review_barriers)").all() as Array<{ name: string }>;
  state.exec(`
    DROP TRIGGER IF EXISTS runtime_review_attempt_v2_insert;
    DROP TRIGGER IF EXISTS runtime_review_attempt_v2_update;
    DROP TRIGGER IF EXISTS runtime_review_barrier_v2_update;
    ${columns.some((column) => column.name === "launch_authority_version")
      ? "ALTER TABLE runtime_review_barriers DROP COLUMN launch_authority_version;"
      : ""}
    PRAGMA user_version = 3;

    INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
    VALUES
      ('run-0','run-0','review',1,'completed',1,1),
      ('run-1','run-1','review',1,'completed',2,2);
    INSERT INTO collaboration_runs VALUES ('workflow','{\"status\":\"completed\"}',1,3);
    INSERT INTO collaboration_dispatch_outbox
      (dispatch_id,workflow_id,payload_json,published_at,terminal_reason)
    VALUES ('dispatch','workflow','{}',4,'completed');
    INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
       run_state,created_at,project,requester,source_fingerprint,changed_files)
    VALUES ('review','stage',X'01','hash','workspace-read','review-key',
      'FULL_CROSS_PROVIDER',5,'/repo','codex','fingerprint',1);
    INSERT INTO runtime_review_lanes
      (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
       idempotency_key,prompt,degraded,result,terminal_at)
    VALUES ('review','codex','auditor','completed','gpt-5.6-sol','max','routing-v5',
      '[]','lane-session','lane-key','audit',0,'{}',6);
    INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at) VALUES
      ('review','codex','auditor',0,'run-0',7),
      ('review','codex','auditor',1,'run-1',8);
    INSERT INTO approval_grants VALUES ('approval','/repo','workspace-read',100,2,1);
    INSERT INTO approval_consumptions VALUES ('consumer','approval','/repo','workspace-read',9);
    INSERT INTO worktree_leases VALUES ('/repo','task','lease','codex',1,9,'routing-v5');
    INSERT INTO worktree_handoffs (task_id,recorded_at,payload) VALUES ('task',10,'{}');
  `);
  state.close();
}

function tableRows(db: Database.Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

describe("launch authority state schema v4 migration", () => {
  it("creates a fresh v4 schema with the legacy-safe default and enforcement triggers", () => {
    const paths = databases();
    initializeCurrentExecutionSchema(paths.state);
    const db = new Database(paths.state, { readonly: true });
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(4);
    expect((db.prepare("PRAGMA table_info(runtime_review_barriers)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((column) => column.name === "launch_authority_version")).toMatchObject({
      notnull: 1,
      dflt_value: "1",
    });
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'runtime_review_%_v2_%' ORDER BY name`).pluck().all()).toEqual([
      "runtime_review_attempt_v2_insert",
      "runtime_review_attempt_v2_update",
      "runtime_review_barrier_v2_update",
    ].sort());
    db.close();
  });

  it("migrates v3 in place, preserves every row, and leaves history at v2", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    const tables = [
      "runs",
      "collaboration_runs",
      "collaboration_dispatch_outbox",
      "runtime_provider_health",
      "runtime_review_barriers",
      "runtime_review_lanes",
      "runtime_review_lane_attempts",
      "approval_grants",
      "approval_consumptions",
      "worktree_leases",
      "worktree_handoffs",
    ];
    const beforeDb = new Database(paths.state, { readonly: true });
    const before = Object.fromEntries(tables.map((table) => [table, tableRows(beforeDb, table)]));
    beforeDb.close();

    expect(new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV4()).toEqual({ status: "migrated", fromVersion: 3, toVersion: 4 });

    const migrated = new Database(paths.state, { readonly: true });
    expect(Number(migrated.pragma("user_version", { simple: true }))).toBe(4);
    for (const table of tables) {
      const rows = tableRows(migrated, table);
      if (table === "runtime_review_barriers") {
        expect(rows).toEqual((before[table] as Array<Record<string, unknown>>).map((row) => ({
          ...row,
          launch_authority_version: 1,
        })));
      } else {
        expect(rows).toEqual(before[table]);
      }
    }
    expect(migrated.prepare(
      "SELECT launch_authority_version FROM runtime_review_barriers WHERE review_id='review'",
    ).pluck().get()).toBe(1);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const history = new Database(paths.history, { readonly: true });
    expect(Number(history.pragma("user_version", { simple: true }))).toBe(2);
    expect(history.prepare("SELECT * FROM sources").all()).toHaveLength(1);
    history.close();
  });

  it("enforces a single ordinal-zero attempt for authority v2 while preserving v1 retries", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    const coordinator = new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    });
    coordinator.migrateToV4();

    const db = new Database(paths.state);
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
       run_state,created_at,launch_authority_version)
      VALUES ('review-v2','stage',X'02','hash-v2','workspace-read','review-v2-key',
        'FULL_CROSS_PROVIDER',20,2)`).run();
    db.prepare(`INSERT INTO runtime_review_lanes
      (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
       idempotency_key,prompt,degraded)
      VALUES ('review-v2','codex','critic','queued','gpt-5.6-sol','max','routing-v5',
        '[]','v2-session','v2-lane','critic',0)`).run();
    db.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
      VALUES ('v2-run-0','v2-run-0','review',1,'queued',20,20)`).run();
    db.prepare(`INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at) VALUES
      ('review-v2','codex','critic',0,'v2-run-0',20)`).run();

    db.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
      VALUES ('v2-run-1','v2-run-1','review',1,'queued',21,21)`).run();
    expect(() => db.prepare(`INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at) VALUES
      ('review-v2','codex','critic',1,'v2-run-1',21)`).run()).toThrow(/launch authority v2/i);
    expect(() => db.prepare(`UPDATE runtime_review_lane_attempts SET attempt_ordinal=1
      WHERE review_id='review-v2' AND agent='codex' AND role='critic'`).run()).toThrow(/launch authority v2/i);
    expect(() => db.prepare(`UPDATE runtime_review_barriers SET launch_authority_version=2
      WHERE review_id='review'`).run()).toThrow(/launch authority v2/i);

    db.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at)
      VALUES ('run-2','run-2','review',1,'queued',22,22)`).run();
    db.prepare(`INSERT INTO runtime_review_lane_attempts
      (review_id,agent,role,attempt_ordinal,run_id,created_at) VALUES
      ('review','codex','auditor',2,'run-2',22)`).run();
    expect(db.prepare(`SELECT attempt_ordinal FROM runtime_review_lane_attempts
      WHERE review_id='review' ORDER BY attempt_ordinal`).pluck().all()).toEqual([0, 1, 2]);
    db.close();
  });

  it("is idempotent and rejects invalid authority versions", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    const coordinator = new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    });
    expect(coordinator.migrateToV4()).toEqual({ status: "migrated", fromVersion: 3, toVersion: 4 });
    expect(coordinator.migrateToV4()).toEqual({ status: "already_current", fromVersion: 4, toVersion: 4 });

    const db = new Database(paths.state);
    expect(() => db.prepare(`INSERT INTO runtime_review_barriers
      (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
       run_state,created_at,launch_authority_version)
      VALUES ('bad','stage',X'03','bad','workspace-read','bad',
        'FULL_CROSS_PROVIDER',30,3)`).run()).toThrow(/check constraint/i);
    db.close();
  });

  it("rolls back schema, triggers, and marker after a pre-commit fault", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v3_commit") throw new Error("injected v4 pre-commit fault");
      },
    }).migrateToV4()).toThrow(/injected v4 pre-commit fault/i);

    const db = new Database(paths.state, { readonly: true });
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(3);
    expect((db.prepare("PRAGMA table_info(runtime_review_barriers)").all() as Array<{ name: string }>)
      .some((column) => column.name === "launch_authority_version")).toBe(false);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'runtime_review_%_v2_%'`).all()).toEqual([]);
    db.close();
  });
});
