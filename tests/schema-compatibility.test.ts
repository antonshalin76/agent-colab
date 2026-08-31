import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MigrationCoordinator, verifyCompatibilityRuntime } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import {
  GRAPH_EXECUTION_MODE,
  openExistingStateLayout,
} from "../src/store/state-layout.js";
import { RunStore } from "../src/store/run-store.js";

const launcher = resolve("scripts/agent-collab-launcher.mjs");
const roots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-schema-compatibility-"));
  const bin = join(root, "bin");
  const stateRoot = join(root, "state");
  roots.push(root);
  mkdirSync(bin);
  const systemctl = join(bin, "systemctl");
  writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\nexit 3\n");
  chmodSync(systemctl, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    AGENT_COLLAB_STATE_DIR: stateRoot,
  };
  const run = (command: string, extraEnv: NodeJS.ProcessEnv = {}) => spawnSync(
    process.execPath,
    [launcher, command],
    { cwd: resolve("."), encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 30_000 },
  );
  return {
    root,
    stateRoot,
    state: join(stateRoot, "collaboration.db"),
    history: join(stateRoot, "history.db"),
    env,
    run,
  };
};

const schemaAndRows = (path: string): unknown => {
  const db = new Database(path, { readonly: true });
  try {
    const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
    const versions = {
      userVersion: Number(db.pragma("user_version", { simple: true })),
      applicationId: Number(db.pragma("application_id", { simple: true })),
    };
    const tables = (db.prepare(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[])
      .map((name) => ({ name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
    return { versions, schema, tables };
  } finally {
    db.close();
  }
};

const physicalInventory = (root: string): Record<string, string> => Object.fromEntries(
  readdirSync(root).sort().map((name) => [
    name,
    createHash("sha256").update(readFileSync(join(root, name))).digest("hex"),
  ]),
);

const removeReviewExtension = (path: string): void => {
  const db = new Database(path);
  try {
    const extensionTriggers = db.prepare(`SELECT name FROM sqlite_schema
      WHERE type='trigger' AND name NOT IN (
        'runtime_review_attempt_v2_insert',
        'runtime_review_attempt_v2_update',
        'runtime_review_barrier_v2_update'
      ) AND (name LIKE 'runtime_review_%' OR name LIKE 'runtime_provider_recovery_%')`)
      .pluck().all() as string[];
    db.transaction(() => {
      for (const trigger of extensionTriggers) db.exec(`DROP TRIGGER "${trigger.replaceAll('"', '""')}"`);
      for (const table of [
        "runtime_review_no_spawn_effects",
        "runtime_review_spawn_authorities",
        "runtime_review_generation_consumptions",
        "runtime_review_attempt_authorities",
        "runtime_review_receipt_lifecycle",
        "runtime_review_receipt_heads",
        "runtime_review_receipts",
        "runtime_review_attempt_base_policies",
        "runtime_provider_recovery_generations",
        "runtime_schema_capabilities",
      ]) db.exec(`DROP TABLE "${table}"`);
    })();
  } finally {
    db.close();
  }
};

const downgradeToV3 = (path: string): void => {
  removeReviewExtension(path);
  const db = new Database(path);
  try {
    db.exec(`
      DROP TRIGGER runtime_review_attempt_v2_insert;
      DROP TRIGGER runtime_review_attempt_v2_update;
      DROP TRIGGER runtime_review_barrier_v2_update;
      ALTER TABLE runtime_review_barriers DROP COLUMN launch_authority_version;
      PRAGMA user_version = 3;
    `);
  } finally {
    db.close();
  }
};

const legacyStoreContractBytes = (statePath: string, historyPath: string): string => {
  const runs = new RunStore(statePath);
  try {
    const input = {
      idempotencyKey: "legacy-write-key",
      stage: "testing",
      priority: 3,
      now: 100,
      payload: { value: 1 },
    } as const;
    const first = runs.enqueueExact(input);
    const replay = runs.enqueueExact(input);
    expect(replay.id).toBe(first.id);
    expect(() => runs.enqueueExact({ ...input, stage: "implementation" })).toThrow(/conflicts/i);
  } finally {
    runs.close();
  }
  const providers = new ProviderHealthStore(statePath, { cooldownMs: 60_000 });
  const providerSnapshot = providers.snapshot();
  providers.close();
  const history = new Database(historyPath);
  try {
    history.prepare(`INSERT INTO history_issues(project,source_path,code,source_line,details)
      VALUES ('/legacy','/legacy/source','write',2,'same bytes')`).run();
  } finally {
    history.close();
  }
  const stateRead = new Database(statePath, { readonly: true });
  const historyRead = new Database(historyPath, { readonly: true });
  try {
    return JSON.stringify({
      run: stateRead.prepare(`SELECT id,idempotency_key,stage,priority,status,created_at,
        next_attempt_at,launched,attempt_count,payload FROM runs WHERE idempotency_key='legacy-write-key'`).get(),
      providers: providerSnapshot,
      history: historyRead.prepare(`SELECT project,source_path,code,source_line,details
        FROM history_issues WHERE project='/legacy'`).get(),
    }, (_key, value) => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? "<generated-id>" : value);
  } finally {
    historyRead.close();
    stateRead.close();
  }
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deployed v3/v4 compatibility runtime", () => {
  it.each([3, 4] as const)("reopens a populated v%s/2 pair read-only with graph execution disabled", (version) => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const state = new Database(fx.state);
    state.prepare(`INSERT INTO runs
      (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,launched,attempt_count)
      VALUES ('legacy-run','legacy-key','implementation',7,'queued',10,10,0,0)`).run();
    state.close();
    const history = new Database(fx.history);
    history.prepare(`INSERT INTO history_issues(project,source_path,code,source_line,details)
      VALUES ('/project','/source','legacy',1,'preserve')`).run();
    history.close();
    if (version === 3) downgradeToV3(fx.state);
    const before = { state: schemaAndRows(fx.state), history: schemaAndRows(fx.history) };
    const inventoryBefore = physicalInventory(fx.stateRoot);

    const receipt = verifyCompatibilityRuntime({
      stateDatabase: fx.state,
      historyDatabase: fx.history,
    });

    expect(receipt).toMatchObject({
      schemaVersion: "compatibility-runtime-open-observation/v1",
      stateVersion: version,
      historyVersion: 2,
      openMode: "read_only",
      graphExecution: "disabled",
      integrity: { state: "ok", history: "ok", foreignKeys: "ok" },
    });
    expect(receipt.stateSchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.historySchemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect({ state: schemaAndRows(fx.state), history: schemaAndRows(fx.history) }).toEqual(before);
    expect(physicalInventory(fx.stateRoot)).toEqual(inventoryBefore);
  });

  it("accepts the migration-owned routing-v5 v4 profile before the offline review extension", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    downgradeToV3(fx.state);
    expect(new MigrationCoordinator({
      stateDatabase: fx.state,
      historyDatabase: fx.history,
    }).migrateToV4()).toEqual({ status: "migrated", fromVersion: 3, toVersion: 4 });
    expect(verifyCompatibilityRuntime({
      stateDatabase: fx.state,
      historyDatabase: fx.history,
    })).toMatchObject({ stateProfile: "v4_routing_v5", reviewSchema: "routing_v5" });
  });

  it.each([
    [3, 1], [3, 3], [4, 1], [4, 3], [5, 2],
  ] as const)("rejects unsupported state/history pair %s/%s without repair", (stateVersion, historyVersion) => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    if (stateVersion === 3) downgradeToV3(fx.state);
    const state = new Database(fx.state);
    state.pragma(`user_version = ${stateVersion}`);
    state.close();
    const history = new Database(fx.history);
    history.pragma(`user_version = ${historyVersion}`);
    history.close();
    const before = { state: schemaAndRows(fx.state), history: schemaAndRows(fx.history) };
    expect(() => verifyCompatibilityRuntime({ stateDatabase: fx.state, historyDatabase: fx.history }))
      .toThrow(new RegExp(`unsupported compatibility schema pair.*state=${stateVersion}.*history=${historyVersion}`, "i"));
    expect({ state: schemaAndRows(fx.state), history: schemaAndRows(fx.history) }).toEqual(before);
  });

  it("rejects partial and capability-tampered schemas without repairing them", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const state = new Database(fx.state);
    state.exec("DROP INDEX runs_due");
    state.close();
    const tampered = schemaAndRows(fx.state);
    expect(() => verifyCompatibilityRuntime({ stateDatabase: fx.state, historyDatabase: fx.history }))
      .toThrow(/missing v4 index: runs_due/i);
    expect(schemaAndRows(fx.state)).toEqual(tampered);

    const fxCapabilities = fixture();
    expect(fxCapabilities.run("status").status).toBe(0);
    const capabilities = new Database(fxCapabilities.state);
    capabilities.prepare(`INSERT INTO runtime_schema_capabilities(capability,capability_version)
      VALUES ('graph-execution',1)`).run();
    capabilities.close();
    expect(() => verifyCompatibilityRuntime({
      stateDatabase: fxCapabilities.state,
      historyDatabase: fxCapabilities.history,
    })).toThrow(/capability marker set/i);
  });

  it.each([
    ["extra table", "CREATE TABLE legacy_extra(value TEXT)"],
    ["extra trigger", `CREATE TRIGGER legacy_extra_trigger AFTER INSERT ON runs
      BEGIN UPDATE runs SET priority=priority WHERE id=NEW.id; END`],
    ["extra column", "ALTER TABLE runs ADD COLUMN legacy_extra TEXT"],
  ])("rejects a legacy schema profile with %s", (_label, ddl) => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const state = new Database(fx.state);
    state.exec(ddl);
    state.close();
    const before = schemaAndRows(fx.state);
    expect(() => verifyCompatibilityRuntime({ stateDatabase: fx.state, historyDatabase: fx.history }))
      .toThrow(/legacy state schema profile mismatch/i);
    expect(schemaAndRows(fx.state)).toEqual(before);
  });

  it("rejects altered legacy constraints and exact-index signatures", () => {
    const constraintFx = fixture();
    expect(constraintFx.run("status").status).toBe(0);
    const constraintDb = new Database(constraintFx.state);
    constraintDb.unsafeMode(true);
    constraintDb.pragma("writable_schema = ON");
    constraintDb.prepare(`UPDATE sqlite_master SET sql=replace(sql,
      'priority INTEGER NOT NULL', 'priority INTEGER') WHERE type='table' AND name='runs'`).run();
    constraintDb.pragma("writable_schema = OFF");
    constraintDb.pragma("schema_version = 999");
    constraintDb.close();
    expect(() => verifyCompatibilityRuntime({
      stateDatabase: constraintFx.state,
      historyDatabase: constraintFx.history,
    })).toThrow(/legacy state schema profile mismatch/i);

    const indexFx = fixture();
    expect(indexFx.run("status").status).toBe(0);
    const indexDb = new Database(indexFx.state);
    indexDb.exec("DROP INDEX runs_due; CREATE INDEX runs_due ON runs(status,priority)");
    indexDb.close();
    expect(() => verifyCompatibilityRuntime({
      stateDatabase: indexFx.state,
      historyDatabase: indexFx.history,
    })).toThrow(/invalid signature/i);
  });

  it.each([
    ["missing handoff index", "DROP INDEX idx_worktree_handoffs_task", /invalid index signature/i],
    ["reordered handoff index", `DROP INDEX idx_worktree_handoffs_task;
      CREATE INDEX idx_worktree_handoffs_task ON worktree_handoffs(id,task_id)`, /invalid index signature/i],
    ["partial handoff index", `DROP INDEX idx_worktree_handoffs_task;
      CREATE INDEX idx_worktree_handoffs_task ON worktree_handoffs(task_id,id) WHERE id>0`, /invalid index signature/i],
    ["additive unique index", "CREATE UNIQUE INDEX runs_stage_unique_extra ON runs(stage,id)", /unique indexes are forbidden/i],
    ["commented additive unique index", "CREATE /*comment*/ UNIQUE INDEX runs_stage_unique_extra ON runs(stage,id)", /unique indexes are forbidden/i],
  ])("rejects %s", (_label, ddl, expected) => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const state = new Database(fx.state);
    state.exec(ddl);
    state.close();
    expect(() => verifyCompatibilityRuntime({ stateDatabase: fx.state, historyDatabase: fx.history }))
      .toThrow(expected);
  });

  it("rejects an altered exact history-v2 profile", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const history = new Database(fx.history);
    history.exec("CREATE TABLE history_extra(value TEXT)");
    history.close();
    expect(() => verifyCompatibilityRuntime({ stateDatabase: fx.state, historyDatabase: fx.history }))
      .toThrow(/history v2 schema profile mismatch/i);
  });

  it("fails stale when another connection writes during inspection", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    expect(() => verifyCompatibilityRuntime({
      stateDatabase: fx.state,
      historyDatabase: fx.history,
      faultInjector: (point) => {
        if (point !== "after_snapshot") return;
        const writer = new Database(fx.state);
        try {
          writer.prepare(`INSERT INTO runs
            (id,idempotency_key,stage,priority,status,created_at,next_attempt_at,launched,attempt_count)
            VALUES ('concurrent','concurrent','testing',1,'queued',1,1,0,0)`).run();
        } finally {
          writer.close();
        }
      },
    })).toThrow(/changed while it was being verified/i);
  });

  it("distinguishes complete synthetic graph v4 from partial graph DDL while keeping execution disabled", () => {
    const complete = fixture();
    expect(complete.run("status").status).toBe(0);
    const completeDb = new Database(complete.state);
    completeDb.exec(readFileSync(resolve("docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql"), "utf8"));
    completeDb.close();
    const completeBefore = schemaAndRows(complete.state);
    expect(verifyCompatibilityRuntime({
      stateDatabase: complete.state,
      historyDatabase: complete.history,
    })).toMatchObject({ graphSchema: "complete_disabled", graphExecution: "disabled" });
    expect(schemaAndRows(complete.state)).toEqual(completeBefore);

    const additiveIndex = new Database(complete.state);
    additiveIndex.exec("CREATE INDEX graph_flows_status_extra ON graph_flows(status)");
    additiveIndex.close();
    expect(verifyCompatibilityRuntime({
      stateDatabase: complete.state,
      historyDatabase: complete.history,
    }).graphSchema).toBe("complete_disabled");

    const ownedTrigger = new Database(complete.state);
    ownedTrigger.exec(`CREATE TRIGGER unrelated_name_after_graph_flow_insert AFTER INSERT ON graph_flows
      BEGIN SELECT RAISE(ABORT,'unexpected graph trigger'); END`);
    ownedTrigger.close();
    expect(() => verifyCompatibilityRuntime({
      stateDatabase: complete.state,
      historyDatabase: complete.history,
    })).toThrow(/partial or altered graph v4 schema|legacy state schema profile mismatch/i);

    const partial = fixture();
    expect(partial.run("status").status).toBe(0);
    const partialDb = new Database(partial.state);
    partialDb.exec("CREATE TABLE graph_flows(flow_id TEXT PRIMARY KEY)");
    partialDb.close();
    const partialBefore = schemaAndRows(partial.state);
    expect(() => verifyCompatibilityRuntime({
      stateDatabase: partial.state,
      historyDatabase: partial.history,
    })).toThrow(/partial or altered graph v4 schema/i);
    expect(schemaAndRows(partial.state)).toEqual(partialBefore);
  });

  it("keeps deterministic legacy writes byte-compatible across verified v3/2 and v4/2", () => {
    const v3 = fixture();
    const v4 = fixture();
    expect(v3.run("status").status).toBe(0);
    expect(v4.run("status").status).toBe(0);
    downgradeToV3(v3.state);
    expect(verifyCompatibilityRuntime({ stateDatabase: v3.state, historyDatabase: v3.history }).stateVersion).toBe(3);
    expect(verifyCompatibilityRuntime({ stateDatabase: v4.state, historyDatabase: v4.history }).stateVersion).toBe(4);

    expect(legacyStoreContractBytes(v3.state, v3.history)).toBe(legacyStoreContractBytes(v4.state, v4.history));
    expect(verifyCompatibilityRuntime({ stateDatabase: v3.state, historyDatabase: v3.history }).graphSchema).toBe("absent");
    expect(verifyCompatibilityRuntime({ stateDatabase: v4.state, historyDatabase: v4.history }).graphSchema).toBe("absent");
  });

  it("exposes a deterministic CLI reopen receipt and never honors an environment enable switch", () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const before = { state: schemaAndRows(fx.state), history: schemaAndRows(fx.history) };
    const first = fx.run("compatibility-status", { AGENT_COLLAB_GRAPH_EXECUTION: "enabled" });
    const second = fx.run("compatibility-status", { AGENT_COLLAB_GRAPH_EXECUTION: "1" });
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
    expect(JSON.parse(first.stdout)).toMatchObject({ graphExecution: "disabled", openMode: "read_only" });
    expect(GRAPH_EXECUTION_MODE).toBe("disabled");
    expect({ state: schemaAndRows(fx.state), history: schemaAndRows(fx.history) }).toEqual(before);
  });

  it("does not create a state root or database while opening compatibility state", () => {
    const fx = fixture();
    rmSync(fx.stateRoot, { recursive: true, force: true });
    expect(() => openExistingStateLayout(fx.stateRoot)).toThrow(/existing state root/i);
    expect(() => readFileSync(fx.state)).toThrow();
    const result = fx.run("compatibility-status");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/existing state root/i);
    expect(() => readFileSync(fx.state)).toThrow();
  });

  it("launches a compatibility-only process that cannot claim work or serve MCP", async () => {
    const fx = fixture();
    expect(fx.run("status").status).toBe(0);
    const child = spawn(process.execPath, [launcher, "compatibility-runtime"], {
      cwd: resolve("."),
      env: { ...fx.env, AGENT_COLLAB_GRAPH_EXECUTION: "enabled" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`compatibility runtime did not become ready: ${stderr}`)), 10_000).unref();
    });
    await Promise.race([
      new Promise<void>((resolveReady) => {
        child.stdout.on("data", () => { if (stdout.includes("\n")) resolveReady(); });
      }),
      deadline,
    ]);
    const observation = JSON.parse(stdout.trim());
    expect(observation).toMatchObject({
      schemaVersion: "compatibility-runtime-process-observation/v1",
      graphExecution: "disabled",
      serviceSurface: "compatibility_only",
      queueClaim: "disabled",
      providerLaunch: "disabled",
      mcpServing: "disabled",
    });
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect([exitCode, signal]).toEqual([0, null]);
  });
});
