import { linkSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { GraphFlowStore } from "../src/store/graph-flow-store.js";
import {
  canonicalJson,
  computeGraphDefinitionSha256,
  computeJsonSha256,
  type GraphFlow,
} from "../src/workflow/flow-contract.js";

const roots: string[] = [];
const graphSchema = readFileSync(resolve("docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql"), "utf8");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-graph-flow-store-"));
  roots.push(root);
  const path = join(root, "state.db");
  initializeCurrentExecutionSchema(path);
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='graph_flows'").get() === undefined) {
    db.exec(graphSchema);
  }
  db.close();
  return path;
}

function flow(overrides: Partial<Record<keyof GraphFlow, unknown>> = {}): GraphFlow {
  const definition = {
    schemaVersion: "GraphFlow/v1",
    flowId: "flow-1",
    taskId: "task-1",
    project: "/repo",
    origin: "codex",
    definitionSha256: "0".repeat(64),
    budget: {
      maxNodes: 4,
      maxActiveReadOnly: 2,
      maxChildDepth: 2,
      maxTokens: 10_000,
      maxWallTimeMs: 60_000,
      maxCostMicrousd: 250_000,
    },
    nodes: [
      {
        nodeId: "root",
        stageKind: "coordination",
        role: "coordinator",
        approvalScope: "workspace-read",
        promptTemplateRef: "prompt:root",
        artifactRef: "artifact:root",
        inputPorts: [],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["route"],
          properties: { route: { type: "string", enum: ["continue"] } },
        },
        joinPolicy: "all_success",
        allowedRoutes: ["continue"],
        timeoutMs: 30_000,
        maxAttempts: 1,
        requestedTokenLimit: 2_000,
      },
      {
        nodeId: "test",
        stageKind: "testing",
        role: "tester",
        approvalScope: "workspace-read",
        promptTemplateRef: "prompt:test",
        artifactRef: "artifact:test",
        inputPorts: [],
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["passed"],
          properties: { passed: { type: "boolean" } },
        },
        joinPolicy: "all_success",
        allowedRoutes: [],
        timeoutMs: 30_000,
        maxAttempts: 2,
        requestedTokenLimit: 2_000,
      },
    ],
    edges: [{
      edgeId: "root-test",
      sourceId: "root",
      targetId: "test",
      condition: { kind: "route", routes: ["continue"] },
    }],
    ...overrides,
  };
  return { ...definition, definitionSha256: computeGraphDefinitionSha256(definition) } as unknown as GraphFlow;
}

function rows(path: string, table: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function submitInWorker(path: string, definition: GraphFlow, now: number): Promise<{ replayed: boolean }> {
  const moduleUrl = pathToFileURL(resolve("src/store/graph-flow-store.ts")).href;
  const workerPath = join(resolve(path, ".."), `submit-${now}.mts`);
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    import { GraphFlowStore } from ${JSON.stringify(moduleUrl)};
    const store = new GraphFlowStore(workerData.path);
    try {
      parentPort.postMessage({ ok: true, value: store.submit({
        definition: workerData.definition, requester: "anton", now: workerData.now,
      }) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
    }
  `;
  writeFileSync(workerPath, source, { encoding: "utf8", mode: 0o600 });
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(pathToFileURL(workerPath), {
      execArgv: ["--import", "tsx"],
      workerData: { path, definition, now },
    });
    worker.once("message", (message: { ok: boolean; value?: { replayed: boolean }; error?: string }) => {
      if (message.ok && message.value) resolveResult(message.value);
      else reject(new Error(message.error ?? "graph flow worker failed without an error"));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`graph flow worker exited with code ${code}`));
    });
  });
}

describe("GraphFlowStore", () => {
  it("atomically stores canonical flow, node, and condition bytes with their hashes", () => {
    const path = databasePath();
    const definition = flow();
    const store = new GraphFlowStore(path);

    expect(store.submit({ definition, requester: "anton", now: 1_000 })).toEqual({
      flowId: "flow-1",
      definitionSha256: definition.definitionSha256,
      status: "submitted",
      replayed: false,
    });
    store.close();

    expect(rows(path, "graph_flows")).toEqual([expect.objectContaining({
      flow_id: definition.flowId,
      project: definition.project,
      origin: definition.origin,
      requester: "anton",
      definition_json: canonicalJson(definition),
      definition_sha256: definition.definitionSha256,
      status: "submitted",
      token_ceiling: definition.budget.maxTokens,
      cost_ceiling_microusd: definition.budget.maxCostMicrousd,
      deadline_at: 61_000,
      version: 1,
      created_at: 1_000,
      updated_at: 1_000,
    })]);
    expect(rows(path, "graph_nodes")).toEqual(definition.nodes.map((node) => expect.objectContaining({
      flow_id: definition.flowId,
      node_id: node.nodeId,
      definition_json: canonicalJson(node),
      definition_sha256: computeJsonSha256(node),
      status: "pending",
      ready_revision: 0,
      version: 1,
      updated_at: 1_000,
    })));
    expect(rows(path, "graph_edges")).toEqual(definition.edges.map((edge) => expect.objectContaining({
      flow_id: definition.flowId,
      edge_id: edge.edgeId,
      source_id: edge.sourceId,
      target_id: edge.targetId,
      condition_json: canonicalJson(edge.condition),
      condition_sha256: computeJsonSha256(edge.condition),
      join_policy: definition.nodes.find((node) => node.nodeId === edge.targetId)!.joinPolicy,
    })));
  });

  it("replays the exact canonical definition across close and reopen without adding rows", () => {
    const path = databasePath();
    const definition = flow();
    const first = new GraphFlowStore(path);
    first.submit({ definition, requester: "anton", now: 1_000 });
    first.close();

    const reordered = {
      origin: definition.origin,
      project: definition.project,
      taskId: definition.taskId,
      schemaVersion: definition.schemaVersion,
      flowId: definition.flowId,
      edges: definition.edges,
      nodes: definition.nodes,
      budget: definition.budget,
      definitionSha256: definition.definitionSha256,
    } satisfies GraphFlow;
    const reopened = new GraphFlowStore(path);
    expect(reopened.submit({ definition: reordered, requester: "anton", now: 9_000 })).toMatchObject({
      flowId: "flow-1",
      replayed: true,
    });
    reopened.close();

    expect(rows(path, "graph_flows")).toHaveLength(1);
    expect(rows(path, "graph_nodes")).toHaveLength(2);
    expect(rows(path, "graph_edges")).toHaveLength(1);
    expect(rows(path, "graph_flows")[0]).toMatchObject({ created_at: 1_000, deadline_at: 61_000 });
  });

  it("converges concurrent SQLite connections on one durable definition", async () => {
    const path = databasePath();
    const definition = flow();
    const results = await Promise.all([
      submitInWorker(path, definition, 1_000),
      submitInWorker(path, definition, 2_000),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(rows(path, "graph_flows")).toHaveLength(1);
    expect(rows(path, "graph_nodes")).toHaveLength(2);
    expect(rows(path, "graph_edges")).toHaveLength(1);
  });

  it("rejects the same flow id with different canonical bytes or requester", () => {
    const path = databasePath();
    const store = new GraphFlowStore(path);
    const original = flow();
    store.submit({ definition: original, requester: "anton", now: 1_000 });

    const changed = flow({ origin: "grok" });
    expect(() => store.submit({ definition: changed, requester: "anton", now: 2_000 }))
      .toThrow(/flow id conflicts with immutable graph definition/i);
    expect(() => store.submit({ definition: original, requester: "other", now: 2_000 }))
      .toThrow(/flow id conflicts with immutable graph definition/i);
    store.close();
  });

  it("rejects a project and definition-hash identity already owned by another flow id", () => {
    const path = databasePath();
    const definition = flow();
    const db = new Database(path);
    db.prepare(`INSERT INTO graph_flows
      (flow_id,project,origin,requester,definition_json,definition_sha256,status,
       token_ceiling,cost_ceiling_microusd,deadline_at,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'submitted',?,?,?,1,?,?)`).run(
        "foreign-flow", definition.project, definition.origin, "anton", canonicalJson(definition),
        definition.definitionSha256, definition.budget.maxTokens,
        definition.budget.maxCostMicrousd ?? null, 61_000, 1_000, 1_000,
      );
    db.close();

    const store = new GraphFlowStore(path);
    expect(() => store.submit({ definition, requester: "anton", now: 2_000 }))
      .toThrow(/project and definition hash conflict with another flow id/i);
    store.close();
    expect(rows(path, "graph_flows")).toHaveLength(1);
  });

  it("rolls back the flow and nodes when an edge insert fails", () => {
    const path = databasePath();
    const store = new GraphFlowStore(path, { faultInjector: (point) => {
      if (point === "before_edge_insert") throw new Error("injected edge failure");
    } });

    expect(() => store.submit({ definition: flow(), requester: "anton", now: 1_000 }))
      .toThrow(/injected edge failure/i);
    store.close();
    expect(rows(path, "graph_flows")).toEqual([]);
    expect(rows(path, "graph_nodes")).toEqual([]);
    expect(rows(path, "graph_edges")).toEqual([]);
  });

  it("never creates execution, attempt, session, admission, or dispatch rows", () => {
    const path = databasePath();
    const store = new GraphFlowStore(path);
    store.submit({ definition: flow(), requester: "anton", now: 1_000 });
    store.close();

    for (const table of [
      "runs",
      "collaboration_runs",
      "collaboration_dispatch_outbox",
      "graph_node_admission_intents",
      "graph_node_attempts",
      "graph_node_admissions",
      "agent_sessions",
    ]) expect(rows(path, table), table).toEqual([]);
  });

  it("requires an existing v4 database with the complete owned graph schema", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-graph-flow-store-invalid-"));
    roots.push(root);
    const absent = join(root, "absent.db");
    expect(() => new GraphFlowStore(absent)).toThrow(/existing graph-complete v4/i);

    const v3 = join(root, "v3.db");
    const v3db = new Database(v3);
    v3db.exec("CREATE TABLE graph_flows(flow_id TEXT PRIMARY KEY); PRAGMA user_version=3;");
    v3db.close();
    expect(() => new GraphFlowStore(v3)).toThrow(/graph-complete v4/i);

    const partial = databasePath();
    const partialDb = new Database(partial);
    partialDb.exec("DROP TABLE graph_edges");
    partialDb.close();
    expect(() => new GraphFlowStore(partial)).toThrow(/graph-complete v4/i);
  });

  it("rejects symlink and hard-link aliases before deriving the restore-guard root", () => {
    const path = databasePath();
    const aliasRoot = mkdtempSync(join(tmpdir(), "agent-collab-graph-alias-"));
    roots.push(aliasRoot);
    const symlink = join(aliasRoot, "symlink.db");
    symlinkSync(path, symlink);
    expect(() => new GraphFlowStore(symlink)).toThrow(/non-symlink|hard-link aliases/i);

    const hardlink = join(aliasRoot, "hardlink.db");
    linkSync(path, hardlink);
    expect(() => new GraphFlowStore(hardlink)).toThrow(/hard-link aliases/i);
  });

  it("revalidates database identity after construction before admitting a graph write", () => {
    const original = databasePath();
    const foreign = databasePath();
    const store = new GraphFlowStore(original);
    renameSync(original, `${original}.detached`);
    symlinkSync(foreign, original);

    expect(() => store.submit({ definition: flow(), requester: "anton", now: 1_000 }))
      .toThrow(/identity changed during its lease/i);
    store.close();
    expect(rows(foreign, "graph_flows")).toEqual([]);
  });
});
