import { createHash } from "node:crypto";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindRereadProgressEvents,
  initializeCurrentExecutionSchema,
  MigrationCoordinator,
  restoreStateV4Backup,
  type V4MigrationReceipt,
} from "../src/migration/coordinator.js";
import { appendStateV4GuardEvent, assertPhysicalRestoreAllowed } from "../src/migration/state-v4-restore-authority.js";
import { StateV4RestoreGuard } from "../src/migration/operational-restore.js";
import { GraphFlowStore } from "../src/store/graph-flow-store.js";
import { RunStore } from "../src/store/run-store.js";
import { computeGraphDefinitionSha256, type GraphFlow } from "../src/workflow/flow-contract.js";
import { dropGraphV4Schema, dropReviewV3Extension } from "./helpers/graph-schema.js";

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
    CREATE TABLE history_issues (
      project TEXT NOT NULL, source_path TEXT NOT NULL, code TEXT NOT NULL,
      source_line INTEGER NOT NULL DEFAULT -1, details TEXT,
      PRIMARY KEY (project, source_path, code, source_line)
    );
    CREATE TABLE memory_source_health (
      project TEXT NOT NULL,
      namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native')),
      status TEXT NOT NULL CHECK (status IN ('projected', 'unavailable', 'no_project_section')),
      source_path TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project, namespace)
    );
    INSERT INTO sources VALUES ('/repo', '/repo/codex.jsonl', 'codex', 7, 1, 'abc', 'session');
    PRAGMA user_version = 2;
  `);
  history.close();
}

function seedStateV3(path: string): void {
  initializeCurrentExecutionSchema(path);
  dropReviewV3Extension(path);
  dropGraphV4Schema(path);
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

function reviewV3GraphAbsentFixture(paths: ReturnType<typeof databases>): Record<string, unknown[]> {
  initializeCurrentExecutionSchema(paths.state);
  dropGraphV4Schema(paths.state);
  seedHistoryV2(paths.history);
  const db = new Database(paths.state);
  db.prepare("INSERT INTO worktree_handoffs(task_id,recorded_at,payload) VALUES ('review-v3',12,'{}')").run();
  const graphTables = new Set([...readFileSync("docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql", "utf8")
    .matchAll(/CREATE TABLE ([a-z0-9_]+)/g)].map((match) => match[1]!));
  const tables = (db.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[])
    .filter((name) => !graphTables.has(name));
  const snapshot = Object.fromEntries(tables.map((table) => [table, tableRows(db, table)]));
  db.close();
  return snapshot;
}

function oneNodeGraph(): GraphFlow {
  const definition = {
    schemaVersion: "GraphFlow/v1",
    flowId: "restore-fence-flow",
    taskId: "restore-fence-task",
    project: "/repo",
    origin: "codex",
    definitionSha256: "0".repeat(64),
    budget: {
      maxNodes: 1, maxActiveReadOnly: 1, maxChildDepth: 1, maxTokens: 1_000,
      maxWallTimeMs: 30_000, maxCostMicrousd: 10_000,
    },
    nodes: [{
      nodeId: "root", stageKind: "coordination", role: "coordinator",
      approvalScope: "workspace-read", promptTemplateRef: "prompt:root", artifactRef: "artifact:root",
      inputPorts: [], outputSchema: { type: "object", additionalProperties: false },
      joinPolicy: "all_success", allowedRoutes: [], timeoutMs: 10_000, maxAttempts: 1,
      requestedTokenLimit: 500,
    }],
    edges: [],
  };
  return { ...definition, definitionSha256: computeGraphDefinitionSha256(definition) } as unknown as GraphFlow;
}

function migrateV3Fixture(paths: ReturnType<typeof databases>): V4MigrationReceipt {
  seedStateV3(paths.state);
  seedHistoryV2(paths.history);
  const result = new MigrationCoordinator({
    stateDatabase: paths.state,
    historyDatabase: paths.history,
  }).migrateToV4();
  if (result.status !== "migrated" || result.toVersion !== 4 || !("backupPath" in result)) {
    throw new Error("fixture did not produce a state-v4 migration receipt");
  }
  return result;
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

    const receipt = new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV4();
    expect(receipt).toMatchObject({
      status: "migrated", fromVersion: 3, toVersion: 4,
      importedProgressEvents: 3,
      lastProgressEventSha256: "924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469",
    });
    expect("backupPath" in receipt).toBe(true);
    if (!("backupPath" in receipt)) throw new Error("missing v4 migration receipt");
    expect(existsSync(receipt.backupPath)).toBe(true);
    expect(createHash("sha256").update(readFileSync(receipt.backupPath)).digest("hex"))
      .toBe(receipt.backupSha256);
    const migrationGuard = new StateV4RestoreGuard({
      journalPath: receipt.guardPath,
      databaseIdentity: receipt.databaseIdentity,
      backupSha256: receipt.backupSha256,
      tableDigestManifestSha256: receipt.tableDigestManifestSha256,
      writeEpoch: receipt.writeEpoch,
    });
    expect(assertPhysicalRestoreAllowed(receipt, migrationGuard.readAndVerify()).event).toBe("backup_created");

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
    expect(migrated.prepare(`SELECT sequence_no,event_sha256 FROM plan_progress_events
      ORDER BY sequence_no`).all()).toEqual([
      { sequence_no: 1, event_sha256: "ca0e9dbd810ab6ed41c8b25c760b71d5bee8c621b60d3895fc778634e63c0bd7" },
      { sequence_no: 2, event_sha256: "98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97" },
      { sequence_no: 3, event_sha256: "924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469" },
    ]);
    expect(migrated.prepare("SELECT COUNT(*) FROM plan_progress_outbox").pluck().get()).toBe(3);
    expect(migrated.prepare("SELECT COUNT(*) FROM graph_flows").pluck().get()).toBe(0);
    migrated.close();

    const history = new Database(paths.history, { readonly: true });
    expect(Number(history.pragma("user_version", { simple: true }))).toBe(2);
    expect(history.prepare("SELECT * FROM sources").all()).toHaveLength(1);
    history.close();
  });

  it("adds only graph persistence to a populated review-v3 v4 database", () => {
    const paths = databases();
    const before = reviewV3GraphAbsentFixture(paths);
    expect(new MigrationCoordinator({ stateDatabase: paths.state, historyDatabase: paths.history })
      .migrateToV4()).toMatchObject({ status: "migrated", fromVersion: 4, toVersion: 4 });
    const db = new Database(paths.state, { readonly: true });
    for (const [table, rows] of Object.entries(before)) expect(tableRows(db, table), table).toEqual(rows);
    expect(db.prepare("SELECT COUNT(*) FROM runtime_schema_capabilities").pluck().get()).toBe(4);
    expect(db.prepare("SELECT COUNT(*) FROM plan_progress_events").pluck().get()).toBe(3);
    db.close();
  });

  it("rolls back and retries the graph migration without changing populated review-v3 rows", () => {
    const paths = databases();
    const before = reviewV3GraphAbsentFixture(paths);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state, historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v4_commit") throw new Error("review-v3 graph commit interrupted");
      },
    }).migrateToV4()).toThrow(/review-v3 graph commit interrupted/i);
    let db = new Database(paths.state, { readonly: true });
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='graph_flows'").get()).toBeUndefined();
    for (const [table, rows] of Object.entries(before)) expect(tableRows(db, table), table).toEqual(rows);
    db.close();

    expect(new MigrationCoordinator({ stateDatabase: paths.state, historyDatabase: paths.history })
      .migrateToV4()).toMatchObject({ status: "migrated", fromVersion: 4, toVersion: 4 });
    db = new Database(paths.state, { readonly: true });
    for (const [table, rows] of Object.entries(before)) expect(tableRows(db, table), table).toEqual(rows);
    db.close();
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
    expect(coordinator.migrateToV4()).toMatchObject({
      status: "migrated", fromVersion: 3, toVersion: 4, importedProgressEvents: 3,
    });
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
        if (point === "before_v4_commit") throw new Error("injected v4 pre-commit fault");
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

  it("reuses the exact guarded backup when retrying a rolled-back migration", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v4_commit") throw new Error("first migration interrupted");
      },
    }).migrateToV4()).toThrow(/first migration interrupted/i);

    const receipt = new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV4();
    expect(receipt).toMatchObject({ status: "migrated", fromVersion: 3, toVersion: 4 });
    const guards = readdirSync(join(paths.state, "..", "migration-guard"))
      .filter((name) => name.endsWith(".jsonl"));
    expect(guards).toHaveLength(1);
    const eventChains = guards.map((name) => readFileSync(
      join(paths.state, "..", "migration-guard", name), "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line).event));
    expect(eventChains).toEqual([["backup_created"]]);
    expect(readdirSync(join(paths.state, "..", "migration-v4"))
      .some((name) => name.startsWith("retired-") && name.endsWith(".json"))).toBe(false);
  });

  it("completes the missing guard when retrying after the durable backup boundary", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "after_v4_backup") throw new Error("backup boundary interrupted");
      },
    }).migrateToV4()).toThrow(/backup boundary interrupted/i);
    expect(readdirSync(join(paths.state, "..", "migration-guard"))).toEqual([]);

    expect(new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV4()).toMatchObject({ status: "migrated", fromVersion: 3, toVersion: 4 });
    expect(readdirSync(join(paths.state, "..", "migration-v4", "backups"))
      .filter((name) => name.endsWith(".db"))).toHaveLength(1);
    expect(readdirSync(join(paths.state, "..", "migration-guard"))
      .filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("adopts one pre-descriptor backup and survives a second crash without duplicating artifacts", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state, historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v4_descriptor") throw new Error("first pre-descriptor crash");
      },
    }).migrateToV4()).toThrow(/first pre-descriptor crash/i);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state, historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "after_v4_backup") throw new Error("second post-descriptor crash");
      },
    }).migrateToV4()).toThrow(/second post-descriptor crash/i);

    expect(new MigrationCoordinator({ stateDatabase: paths.state, historyDatabase: paths.history })
      .migrateToV4()).toMatchObject({ status: "migrated", fromVersion: 3, toVersion: 4 });
    expect(readdirSync(join(paths.state, "..", "migration-v4", "backups"))
      .filter((name) => name.endsWith(".db"))).toHaveLength(1);
  });

  it.each(["trigger", "graph-table"] as const)(
    "does not adopt a pre-descriptor backup with an injected %s schema object",
    (variant) => {
      const paths = databases();
      seedStateV3(paths.state);
      seedHistoryV2(paths.history);
      expect(() => new MigrationCoordinator({
        stateDatabase: paths.state, historyDatabase: paths.history,
        faultInjector: (point) => {
          if (point === "before_v4_descriptor") throw new Error("pre-descriptor tamper window");
        },
      }).migrateToV4()).toThrow(/pre-descriptor tamper window/i);
      const backupRoot = join(paths.state, "..", "migration-v4", "backups");
      const orphan = join(backupRoot, readdirSync(backupRoot).find((name) => name.endsWith(".db"))!);
      const tampered = new Database(orphan);
      tampered.exec(variant === "trigger"
        ? `CREATE TRIGGER injected_orphan_trigger AFTER INSERT ON worktree_handoffs
             BEGIN SELECT 1; END;`
        : "CREATE TABLE graph_injected_orphan(id TEXT PRIMARY KEY)");
      tampered.close();

      const receipt = new MigrationCoordinator({ stateDatabase: paths.state, historyDatabase: paths.history })
        .migrateToV4();
      expect(receipt).toMatchObject({ status: "migrated", fromVersion: 3, toVersion: 4 });
      if (!("backupPath" in receipt)) throw new Error("missing replacement backup receipt");
      expect(receipt.backupPath).not.toBe(orphan);
      const signed = new Database(receipt.backupPath, { readonly: true });
      expect(signed.prepare("SELECT name FROM sqlite_schema WHERE name IN (?,?)")
        .all("injected_orphan_trigger", "graph_injected_orphan")).toEqual([]);
      signed.close();
    },
  );

  it("rejects an orphan whose schema changes after adoption but before descriptor signing", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state, historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v4_descriptor") throw new Error("create adoptable orphan");
      },
    }).migrateToV4()).toThrow(/create adoptable orphan/i);
    const backupRoot = join(paths.state, "..", "migration-v4", "backups");
    const orphan = join(backupRoot, readdirSync(backupRoot).find((name) => name.endsWith(".db"))!);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state, historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point !== "after_v4_orphan_adoption") return;
        const attacker = new Database(orphan);
        attacker.exec(`CREATE TRIGGER injected_after_adoption AFTER INSERT ON worktree_handoffs
          BEGIN SELECT 1; END;`);
        attacker.close();
      },
    }).migrateToV4()).toThrow(/backup verification failed/i);
    expect(existsSync(join(paths.state, "..", "migration-v4", "active-restore-guard.json"))).toBe(false);
    const state = new Database(paths.state, { readonly: true });
    expect(Number(state.pragma("user_version", { simple: true }))).toBe(3);
    state.close();
  });

  it("rechecks backup bytes when the final pre-descriptor hook mutates without throwing", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state, historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point !== "before_v4_descriptor") return;
        const backupRoot = join(paths.state, "..", "migration-v4", "backups");
        const backup = join(backupRoot, readdirSync(backupRoot).find((name) => name.endsWith(".db"))!);
        const attacker = new Database(backup);
        attacker.exec("CREATE TABLE graph_final_hook_injection(id TEXT PRIMARY KEY)");
        attacker.close();
      },
    }).migrateToV4()).toThrow(/backup verification failed/i);
    expect(existsSync(join(paths.state, "..", "migration-v4", "active-restore-guard.json"))).toBe(false);
  });

  it("revalidates the canonical digest of the exact progress bytes read for import", () => {
    const progressRoot = join(process.cwd(), "docs/hybrid-flow-v1-r2/stage-close/pre-v4");
    const payloads = readdirSync(progressRoot).filter((name) => name.endsWith(".json")).sort()
      .map((name) => readFileSync(join(progressRoot, name), "utf8"));
    const parsed = payloads.map((payload) => JSON.parse(payload) as {
      stageId: string; terminalResult: string; eventSha256: string; previousEventSha256: string;
    });
    const verification = {
      startSha256: parsed[0]!.previousEventSha256,
      progressEventCount: parsed.length,
      lastEventSha256: parsed.at(-1)!.eventSha256,
      events: parsed.map(({ stageId, terminalResult, eventSha256 }) => ({ stageId, terminalResult, eventSha256 })),
    };
    expect(bindRereadProgressEvents(verification, payloads).events).toHaveLength(3);
    const replaced = JSON.parse(payloads[1]!) as Record<string, unknown>;
    replaced.eventId = "replaced-after-verification";
    const attacked = [...payloads];
    attacked[1] = JSON.stringify(replaced);
    expect(() => bindRereadProgressEvents(verification, attacked))
      .toThrow(/bytes changed after verification/i);
  });

  it("rolls back DDL and progress import atomically when import faults", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "during_v4_progress_import") throw new Error("injected progress import fault");
      },
    }).migrateToV4()).toThrow(/injected progress import fault/i);
    const db = new Database(paths.state, { readonly: true });
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(3);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='graph_flows'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='plan_progress_events'").get()).toBeUndefined();
    db.close();
  });

  it("aborts before DDL when a writer changes the post-backup epoch", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point !== "after_v4_guard") return;
        const writer = new Database(paths.state);
        try {
          writer.prepare("INSERT INTO worktree_handoffs(task_id,recorded_at,payload) VALUES ('late',11,'{}')").run();
        } finally { writer.close(); }
      },
    }).migrateToV4()).toThrow(/write epoch changed after backup/i);
    const db = new Database(paths.state, { readonly: true });
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(3);
    expect(db.prepare("SELECT task_id FROM worktree_handoffs WHERE task_id='late'").get())
      .toEqual({ task_id: "late" });
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='graph_flows'").get()).toBeUndefined();
    db.close();
  });

  it("rejects an unknown mutable legacy table before creating a backup", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    const db = new Database(paths.state);
    db.exec("CREATE TABLE unexpected_mutable_state(id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
    }).migrateToV4()).toThrow(/unknown or incomplete v3 legacy object set/i);
    const inspected = new Database(paths.state, { readonly: true });
    expect(Number(inspected.pragma("user_version", { simple: true }))).toBe(3);
    expect(inspected.prepare("SELECT 1 FROM sqlite_schema WHERE name='graph_flows'").get()).toBeUndefined();
    inspected.close();
  });

  it("physically restores the exact v3 backup before reopen or mutable writes", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);

    expect(restoreStateV4Backup({ stateDatabase: paths.state, receipt })).toEqual({
      status: "restored",
      stateDatabase: paths.state,
      backupSha256: receipt.backupSha256,
    });
    expect(createHash("sha256").update(readFileSync(paths.state)).digest("hex"))
      .toBe(receipt.backupSha256);
    const restored = new Database(paths.state, { readonly: true });
    expect(Number(restored.pragma("user_version", { simple: true }))).toBe(3);
    expect(restored.prepare("SELECT 1 FROM sqlite_schema WHERE name='graph_flows'").get()).toBeUndefined();
    expect(restored.prepare("SELECT id FROM runs ORDER BY id").pluck().all()).toEqual(["run-0", "run-1"]);
    restored.close();
  });

  it("rejects a copied valid guard from another generation before changing any target bytes", () => {
    const target = databases();
    const targetReceipt = migrateV3Fixture(target);
    const foreign = databases();
    const foreignReceipt = migrateV3Fixture(foreign);
    const copiedGuard = join(target.state, "..", "migration-guard", `state-v4-${foreignReceipt.backupSha256}.jsonl`);
    copyFileSync(foreignReceipt.guardPath, copiedGuard);
    const wrongReceipt = { ...foreignReceipt, guardPath: copiedGuard };
    const descriptorPath = join(target.state, "..", "migration-v4", "active-restore-guard.json");
    const before = {
      state: readFileSync(target.state),
      guard: readFileSync(targetReceipt.guardPath),
      descriptor: readFileSync(descriptorPath),
      sidecars: ["-wal", "-shm", "-journal"].map((suffix) => existsSync(`${target.state}${suffix}`)),
    };
    expect(() => restoreStateV4Backup({ stateDatabase: target.state, receipt: wrongReceipt }))
      .toThrow(/does not match the active authority generation/i);
    expect(readFileSync(target.state)).toEqual(before.state);
    expect(readFileSync(targetReceipt.guardPath)).toEqual(before.guard);
    expect(readFileSync(descriptorPath)).toEqual(before.descriptor);
    expect(["-wal", "-shm", "-journal"].map((suffix) => existsSync(`${target.state}${suffix}`)))
      .toEqual(before.sidecars);
  });

  it("rejects conflicting retirement authority before restore side effects", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    const marker = join(paths.state, "..", "migration-v4", "retirement.pending");
    writeFileSync(marker, `${"f".repeat(64)}\n`, { mode: 0o600 });
    const descriptorPath = join(paths.state, "..", "migration-v4", "active-restore-guard.json");
    const before = {
      state: readFileSync(paths.state),
      guard: readFileSync(receipt.guardPath),
      descriptor: readFileSync(descriptorPath),
      marker: readFileSync(marker),
      sidecars: ["-wal", "-shm", "-journal"].map((suffix) => existsSync(`${paths.state}${suffix}`)),
    };
    expect(() => restoreStateV4Backup({ stateDatabase: paths.state, receipt }))
      .toThrow(/retirement marker conflicts/i);
    expect(readFileSync(paths.state)).toEqual(before.state);
    expect(readFileSync(receipt.guardPath)).toEqual(before.guard);
    expect(readFileSync(descriptorPath)).toEqual(before.descriptor);
    expect(readFileSync(marker)).toEqual(before.marker);
    expect(["-wal", "-shm", "-journal"].map((suffix) => existsSync(`${paths.state}${suffix}`)))
      .toEqual(before.sidecars);
  });

  it("fails migration success when a signed artifact changes before the terminal reread", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    const coordinator = new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point !== "before_v4_terminal_artifact_reread") return;
        const descriptor = JSON.parse(readFileSync(
          join(paths.state, "..", "migration-v4", "active-restore-guard.json"), "utf8",
        )) as { backupPath: string };
        appendFileSync(descriptor.backupPath, "tampered-after-publication");
      },
    });
    expect(() => coordinator.migrateToV4()).toThrow(/terminal state-v4 backup bytes/i);
    expect(() => new MigrationCoordinator({ stateDatabase: paths.state, historyDatabase: paths.history })
      .migrateToV4()).toThrow(/terminal state-v4 backup bytes/i);
  });

  it("revalidates the exact recovery generation after a crash before terminal success", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point === "before_v4_terminal_artifact_reread") throw new Error("simulated terminal crash");
      },
    }).migrateToV4()).toThrow(/simulated terminal crash/i);
    expect(new MigrationCoordinator({ stateDatabase: paths.state, historyDatabase: paths.history })
      .migrateToV4()).toEqual({ status: "already_current", fromVersion: 4, toVersion: 4 });
  });

  it("rejects a non-pristine recovery guard at terminal migration validation", () => {
    const paths = databases();
    seedStateV3(paths.state);
    seedHistoryV2(paths.history);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      faultInjector: (point) => {
        if (point !== "before_v4_terminal_artifact_reread") return;
        const descriptor = JSON.parse(readFileSync(
          join(paths.state, "..", "migration-v4", "active-restore-guard.json"), "utf8",
        )) as V4MigrationReceipt;
        new StateV4RestoreGuard({ journalPath: descriptor.guardPath,
          databaseIdentity: descriptor.databaseIdentity, backupSha256: descriptor.backupSha256,
          tableDigestManifestSha256: descriptor.tableDigestManifestSha256,
          writeEpoch: descriptor.writeEpoch }).append("service_reopened", 999);
      },
    }).migrateToV4()).toThrow(/guard is no longer pristine/i);
  });

  it("rejects restore after a service reopen or a legacy-row mutation", () => {
    const reopenedPaths = databases();
    const reopenedReceipt = migrateV3Fixture(reopenedPaths);
    new StateV4RestoreGuard({
      journalPath: reopenedReceipt.guardPath,
      databaseIdentity: reopenedReceipt.databaseIdentity,
      backupSha256: reopenedReceipt.backupSha256,
      tableDigestManifestSha256: reopenedReceipt.tableDigestManifestSha256,
      writeEpoch: reopenedReceipt.writeEpoch,
    }).append("service_reopened", 100);
    expect(() => restoreStateV4Backup({ stateDatabase: reopenedPaths.state, receipt: reopenedReceipt }))
      .toThrow(/forbidden after reopen/i);

    const writtenPaths = databases();
    const writtenReceipt = migrateV3Fixture(writtenPaths);
    const writer = new Database(writtenPaths.state);
    writer.prepare("INSERT INTO worktree_handoffs(task_id,recorded_at,payload) VALUES ('post-migration',12,'{}')").run();
    writer.close();
    expect(() => restoreStateV4Backup({ stateDatabase: writtenPaths.state, receipt: writtenReceipt }))
      .toThrow(/write epoch or legacy rows changed/i);
  });

  it("records graph write admission before mutation and forbids deleting the submitted graph by restore", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    const store = new GraphFlowStore(paths.state);
    store.submit({ definition: oneNodeGraph(), requester: "anton", now: 1_000 });
    store.close();
    expect(() => restoreStateV4Backup({ stateDatabase: paths.state, receipt }))
      .toThrow(/forbidden after reopen, write admission/i);
    const db = new Database(paths.state, { readonly: true });
    expect(db.prepare("SELECT flow_id FROM graph_flows").pluck().all()).toEqual(["restore-fence-flow"]);
    db.close();
  });

  it("serializes a concurrent graph submission against physical restore without losing the graph", async () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    const workerPath = join(paths.state, "..", "concurrent-submit.mts");
    writeFileSync(workerPath, `
      import { parentPort, workerData } from "node:worker_threads";
      import { GraphFlowStore } from ${JSON.stringify(pathToFileURL(resolve("src/store/graph-flow-store.ts")).href)};
      const store = new GraphFlowStore(workerData.path, { faultInjector: (point) => {
        if (point === "after_write_admission") {
          parentPort.postMessage({ phase: "admitted" });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        }
      } });
      try {
        store.submit({ definition: workerData.definition, requester: "anton", now: 2_000 });
        parentPort.postMessage({ phase: "complete" });
      } catch (error) {
        parentPort.postMessage({ phase: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    `, { mode: 0o600 });
    const worker = new Worker(pathToFileURL(workerPath), {
      execArgv: ["--import", "tsx"],
      workerData: { path: paths.state, definition: oneNodeGraph() },
    });
    const admitted = new Promise<void>((resolveAdmitted, reject) => {
      worker.on("message", (message: { phase: string; error?: string }) => {
        if (message.phase === "admitted") resolveAdmitted();
        if (message.phase === "failed") reject(new Error(message.error));
      });
      worker.once("error", reject);
    });
    const completed = new Promise<void>((resolveComplete, reject) => {
      worker.on("message", (message: { phase: string; error?: string }) => {
        if (message.phase === "complete") resolveComplete();
        if (message.phase === "failed") reject(new Error(message.error));
      });
      worker.once("error", reject);
    });
    await admitted;
    expect(() => restoreStateV4Backup({ stateDatabase: paths.state, receipt }))
      .toThrow(/forbidden after reopen, write admission/i);
    await completed;
    await worker.terminate();
    const db = new Database(paths.state, { readonly: true });
    expect(db.prepare("SELECT flow_id FROM graph_flows").pluck().all()).toEqual(["restore-fence-flow"]);
    db.close();
  });

  it("durably records the service-reopen boundary through the active migration descriptor", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    expect(appendStateV4GuardEvent(join(paths.state, ".."), "service_reopened", 101)).toBe("active");
    const records = new StateV4RestoreGuard({
      journalPath: receipt.guardPath,
      databaseIdentity: receipt.databaseIdentity,
      backupSha256: receipt.backupSha256,
      tableDigestManifestSha256: receipt.tableDigestManifestSha256,
      writeEpoch: receipt.writeEpoch,
    }).readAndVerify();
    expect(records.map(({ event }) => event)).toEqual(["backup_created", "service_reopened"]);
    expect(() => restoreStateV4Backup({ stateDatabase: paths.state, receipt }))
      .toThrow(/forbidden after reopen/i);
  });

  it.each([
    "after_v4_restore_staged",
    "after_v4_restore_consumed",
    "after_v4_restore_renamed",
  ] as const)("recovers an interrupted physical restore at %s", (faultPoint) => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    expect(() => restoreStateV4Backup({
      stateDatabase: paths.state,
      receipt,
      faultInjector: (point) => {
        if (point === faultPoint) throw new Error(`injected ${faultPoint}`);
      },
    })).toThrow(`injected ${faultPoint}`);

    expect(restoreStateV4Backup({ stateDatabase: paths.state, receipt }).status)
      .toBe(faultPoint === "after_v4_restore_staged" ? "restored" : "recovered");
    expect(createHash("sha256").update(readFileSync(paths.state)).digest("hex"))
      .toBe(receipt.backupSha256);
  });

  it("rejects a staged restore after a legacy store reopens and commits a write", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    expect(() => restoreStateV4Backup({
      stateDatabase: paths.state,
      receipt,
      faultInjector: (point) => {
        if (point === "after_v4_restore_staged") throw new Error("pause after staging");
      },
    })).toThrow(/pause after staging/i);
    const runs = new RunStore(paths.state);
    runs.enqueue({ idempotencyKey: "post-stage", stage: "review", priority: 1, now: 500 });
    runs.close();
    expect(new StateV4RestoreGuard({
      journalPath: receipt.guardPath,
      databaseIdentity: receipt.databaseIdentity,
      backupSha256: receipt.backupSha256,
      tableDigestManifestSha256: receipt.tableDigestManifestSha256,
      writeEpoch: receipt.writeEpoch,
    }).readAndVerify().map(({ event }) => event)).toEqual([
      "backup_created", "service_reopened", "mutable_write_admitted",
    ]);
    expect(() => restoreStateV4Backup({ stateDatabase: paths.state, receipt }))
      .toThrow(/write epoch|forbidden after reopen, write admission/i);
    const db = new Database(paths.state, { readonly: true });
    expect(db.prepare("SELECT idempotency_key FROM runs WHERE idempotency_key='post-stage'").pluck().get())
      .toBe("post-stage");
    db.close();
  });

  it("removes unbound SQLite sidecars before reporting consumed-restore recovery", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    expect(() => restoreStateV4Backup({
      stateDatabase: paths.state,
      receipt,
      faultInjector: (point) => {
        if (point === "after_v4_restore_renamed") throw new Error("renamed before directory fsync");
      },
    })).toThrow(/renamed before directory fsync/i);
    writeFileSync(`${paths.state}-wal`, "unbound-wal", { mode: 0o600 });
    writeFileSync(`${paths.state}-shm`, "unbound-shm", { mode: 0o600 });
    writeFileSync(`${paths.state}-journal`, "unbound-journal", { mode: 0o600 });
    expect(restoreStateV4Backup({ stateDatabase: paths.state, receipt }).status).toBe("recovered");
    expect(existsSync(`${paths.state}-wal`)).toBe(false);
    expect(existsSync(`${paths.state}-shm`)).toBe(false);
    expect(existsSync(`${paths.state}-journal`)).toBe(false);
  });

  it("blocks a state store open after restore consumption until replacement recovery completes", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    expect(() => restoreStateV4Backup({
      stateDatabase: paths.state,
      receipt,
      faultInjector: (point) => {
        if (point === "after_v4_restore_consumed") throw new Error("pause after consumption");
      },
    })).toThrow(/pause after consumption/i);
    expect(() => new RunStore(paths.state)).toThrow(/restore consumption is incomplete/i);
    expect(restoreStateV4Backup({ stateDatabase: paths.state, receipt }).status).toBe("recovered");
    const reopened = new RunStore(paths.state);
    reopened.close();
    expect(readdirSync(join(paths.state, "..", "migration-v4", "retired"))
      .filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(() => new MigrationCoordinator({
      stateDatabase: paths.state,
      historyDatabase: paths.history,
      repositoryRoot: process.cwd(),
    }).migrateToV4()).toThrow(/re-migration.*operator reconciliation/i);
  });

  for (const point of [
    "after_v4_restore_root_fsync",
    "after_v4_retired_descriptor_rename",
    "after_v4_retired_directory_fsync",
    "after_v4_active_descriptor_removed",
    "after_v4_active_descriptor_directory_fsync",
  ] as const) {
    it(`recovers descriptor retirement after ${point}`, () => {
      const paths = databases();
      const receipt = migrateV3Fixture(paths);
      expect(() => restoreStateV4Backup({ stateDatabase: paths.state, receipt,
        faultInjector: (candidate) => { if (candidate === point) throw new Error(point); } }))
        .toThrow(point);
      expect(() => new RunStore(paths.state)).toThrow(/restore consumption|retirement is incomplete/i);
      expect(restoreStateV4Backup({ stateDatabase: paths.state, receipt }).status).toBe("recovered");
      const reopened = new RunStore(paths.state);
      reopened.close();
    });
  }

  it("keeps restore retirement bound to the pinned root after pathname replacement", () => {
    const paths = databases();
    const receipt = migrateV3Fixture(paths);
    const root = join(paths.state, "..");
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    expect(() => restoreStateV4Backup({
      stateDatabase: paths.state,
      receipt,
      faultInjector: (point) => {
        if (point !== "after_v4_restore_root_fsync") return;
        renameSync(root, displaced);
        mkdirSync(root, { mode: 0o700 });
      },
    })).toThrow(/state root identity changed while its fence was held/i);
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(join(displaced, "migration-v4", "retired"))
      .filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("rejects an unfenced raw SQLite handle while restore authority is active", () => {
    const paths = databases();
    migrateV3Fixture(paths);
    const raw = new Database(paths.state);
    expect(() => new RunStore(raw)).toThrow(/raw file-backed SQLite handles are unsupported/i);
    raw.close();
  });

  it("rejects a tampered backup artifact", () => {
    const backupPaths = databases();
    const backupReceipt = migrateV3Fixture(backupPaths);
    writeFileSync(backupReceipt.backupPath, "tampered", { flag: "w" });
    expect(() => restoreStateV4Backup({ stateDatabase: backupPaths.state, receipt: backupReceipt }))
      .toThrow(/backup hash mismatch/i);
  });

  it("rejects a tampered manifest artifact", () => {
    const manifestPaths = databases();
    const manifestReceipt = migrateV3Fixture(manifestPaths);
    appendFileSync(manifestReceipt.tableDigestManifestPath, "\n");
    expect(() => restoreStateV4Backup({ stateDatabase: manifestPaths.state, receipt: manifestReceipt }))
      .toThrow(/manifest hash or canonical bytes mismatch/i);
  });

  it("rejects a tampered restore-guard artifact", () => {
    const guardPaths = databases();
    const guardReceipt = migrateV3Fixture(guardPaths);
    appendFileSync(guardReceipt.guardPath, "\n");
    expect(() => restoreStateV4Backup({ stateDatabase: guardPaths.state, receipt: guardReceipt }))
      .toThrow(/journal is malformed/i);
  });

  it("blocks a service reopen when the active guard descriptor is tampered", () => {
    const paths = databases();
    migrateV3Fixture(paths);
    appendFileSync(join(paths.state, "..", "migration-v4", "active-restore-guard.json"), "\n");
    expect(() => appendStateV4GuardEvent(join(paths.state, ".."), "service_reopened"))
      .toThrow(/descriptor hash or canonical bytes mismatch/i);
  });
});
