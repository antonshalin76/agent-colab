import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabaseLease, type StateDatabaseAccess } from "../src/store/state-database-fence.js";
import { RunStore } from "../src/store/run-store.js";
import {
  createTelemetryFixture,
  seedGraphAttempt,
  telemetryRows,
  terminalizeGraphAttempt,
  type TelemetryFixture,
} from "./helpers/flow-telemetry-fixture.js";

type JsonObject = Record<string, unknown>;

interface FlowTelemetryStore {
  createSession(input: JsonObject): { sessionId: string; replayed: boolean };
  createSessionInTransaction(access: StateDatabaseAccess, input: JsonObject): { sessionId: string; replayed: boolean };
  transitionSession(input: JsonObject): { sessionId: string; status: string; replayed: boolean };
  transitionSessionInTransaction(access: StateDatabaseAccess, input: JsonObject): {
    sessionId: string; status: string; replayed: boolean;
  };
  appendEvent(input: JsonObject): { eventId: string; sequenceNo: number; eventSha256: string; replayed: boolean };
  appendEventInTransaction(access: StateDatabaseAccess, input: JsonObject): {
    eventId: string; sequenceNo: number; eventSha256: string; replayed: boolean;
  };
  recordUsage(input: JsonObject): { usageId: string; eventId: string; replayed: boolean };
  recordUsageInTransaction(access: StateDatabaseAccess, input: JsonObject): {
    usageId: string; eventId: string; replayed: boolean;
  };
  recordAttemptTerminal(input: JsonObject): { eventId: string; replayed: boolean };
  recordAttemptTerminalInTransaction(access: StateDatabaseAccess, input: JsonObject): {
    eventId: string; replayed: boolean;
  };
  getRunTelemetryLink(runId: string): JsonObject;
  close(): void;
}

type FlowTelemetryStoreConstructor = new (
  database: string | StateDatabaseAccess,
  options?: {
    faultInjector?: (point: string) => void;
    telemetryExporter?: (payload: Readonly<JsonObject>) => unknown | Promise<unknown>;
    telemetryExportTimeoutMs?: number;
  },
) => FlowTelemetryStore;

const roots: string[] = [];
const MAX_STABLE_ID_BYTES = 128;
const MAX_PROVIDER_SESSION_REF_BYTES = 256;
const VALID_TRACE_ID = `${"0".repeat(31)}1`;
const VALID_SPAN_ID = `${"0".repeat(15)}1`;
const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("test value is not canonicalizable");
  return encoded;
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function persistedDatabaseText(databasePath: string): string {
  const db = new Database(databasePath, { readonly: true });
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[];
    const values: string[] = [];
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      for (const row of db.prepare(`SELECT * FROM ${quotedTable}`).all() as Array<Record<string, unknown>>) {
        for (const value of Object.values(row)) {
          if (typeof value === "string") values.push(value);
          else if (Buffer.isBuffer(value)) values.push(value.toString("utf8"));
        }
      }
    }
    return values.join("\n");
  } finally {
    db.close();
  }
}

const fixture = (): TelemetryFixture => {
  const created = createTelemetryFixture();
  roots.push(created.root);
  return created;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loadStore(): Promise<FlowTelemetryStoreConstructor> {
  const module = await import(pathToFileURL(resolve("src/store/flow-telemetry-store.ts")).href);
  return module.FlowTelemetryStore as FlowTelemetryStoreConstructor;
}

function createRootSession(
  store: FlowTelemetryStore,
  input: {
    flowId?: string; attemptId?: string; sessionId?: string; providerSessionId?: string; createdAt?: number;
  } = {},
): void {
  const flowId = input.flowId ?? "flow-a";
  const attemptId = input.attemptId ?? "attempt-a";
  const sessionId = input.sessionId ?? "session-a";
  store.createSession({
    sessionId,
    flowId,
    attemptId,
    parentSessionId: null,
    kind: "node_attempt",
    createdAt: input.createdAt ?? 1_000,
  });
  store.transitionSession({
    flowId,
    sessionId,
    expectedStatus: "created",
    status: "running",
    providerSessionRef: {
      schemaVersion: "ProviderSessionRef/v1",
      value: input.providerSessionId ?? `provider-${sessionId}`,
      provenance: "provider_reported",
    },
    now: (input.createdAt ?? 1_000) + 100,
  });
}

const eventInput = (overrides: JsonObject = {}): JsonObject => ({
  eventId: "event-a-1",
  flowId: "flow-a",
  nodeId: "node-a",
  attemptId: "attempt-a",
  sessionId: "session-a",
  eventType: "attempt_started",
  eventVersion: "1",
  payload: {
    schemaVersion: "TelemetryPayload/v1",
    parentSessionId: null,
    data: { state: "running" },
  },
  parentSessionId: null,
  traceId: null,
  spanId: null,
  createdAt: 1_200,
  ...overrides,
});

const exactUsage = (overrides: JsonObject = {}): JsonObject => ({
  flowId: "flow-a",
  nodeId: "node-a",
  attemptId: "attempt-a",
  sessionId: "session-a",
  usageId: "usage-a-1",
  provider: "codex",
  providerSessionId: "provider-session-a",
  receiptId: "provider-receipt-a-1",
  scope: "self",
  coveredAttemptIds: [],
  normalizedUsage: {
    status: "exact",
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 5,
    reasoningTokens: 1,
    totalTokens: 15,
    costUsd: 0.0042,
    costMicroUsd: 4_200,
    provenance: {
      inputTokens: "provider_reported",
      cachedInputTokens: "provider_reported",
      outputTokens: "provider_reported",
      reasoningTokens: "provider_reported",
      totalTokens: "provider_reported",
      costUsd: "provider_reported",
      costMicroUsd: "lossless_usd_to_microusd",
    },
  },
  createdAt: 1_300,
  ...overrides,
});

const partialUsage = (overrides: JsonObject = {}): JsonObject => exactUsage({
  usageId: "usage-a-partial",
  receiptId: "provider-receipt-a-partial",
  normalizedUsage: {
    status: "partial",
    inputTokens: 10,
    cachedInputTokens: null,
    outputTokens: 5,
    reasoningTokens: null,
    totalTokens: 15,
    costUsd: 0.0000005,
    costMicroUsd: null,
    provenance: {
      inputTokens: "provider_reported",
      cachedInputTokens: "unavailable",
      outputTokens: "provider_reported",
      reasoningTokens: "unavailable",
      totalTokens: "provider_reported",
      costUsd: "provider_reported",
      costMicroUsd: "unavailable_fractional_microusd",
    },
  },
  ...overrides,
});

const unavailableUsage = (overrides: JsonObject = {}): JsonObject => exactUsage({
  usageId: "usage-a-unavailable",
  receiptId: "provider-receipt-a-unavailable",
  normalizedUsage: {
    status: "unavailable",
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costUsd: null,
    costMicroUsd: null,
    provenance: {
      inputTokens: "unavailable",
      cachedInputTokens: "unavailable",
      outputTokens: "unavailable",
      reasoningTokens: "unavailable",
      totalTokens: "unavailable",
      costUsd: "unavailable",
      costMicroUsd: "unavailable",
    },
  },
  ...overrides,
});

const terminalInput = (overrides: JsonObject = {}): JsonObject => ({
  flowId: "flow-a",
  nodeId: "node-a",
  attemptId: "attempt-a",
  sessionId: "session-a",
  provider: "codex",
  attemptOrdinal: 1,
  outcome: "succeeded",
  errorClassification: null,
  startedAt: 1_000,
  terminalAt: 1_400,
  usageObservation: { status: "exact", usageId: "usage-a-1" },
  ...overrides,
});

const expectedUnsignedEvent = (
  input: JsonObject,
  sequenceNo: number,
  previousEventSha256: string | null,
): JsonObject => {
  const payloadJson = canonicalJson(input.payload);
  return {
    schemaVersion: "FlowEvent/v1",
    eventId: input.eventId,
    flowId: input.flowId,
    sequenceNo,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    payloadSha256: sha256(payloadJson),
    previousEventSha256,
    parentSessionId: input.parentSessionId,
    traceId: input.traceId,
    spanId: input.spanId,
    createdAt: input.createdAt,
  };
};

const expectedEventRow = (
  input: JsonObject,
  sequenceNo: number,
  previousEventSha256: string | null,
): JsonObject => {
  const unsigned = expectedUnsignedEvent(input, sequenceNo, previousEventSha256);
  return {
    event_id: input.eventId,
    flow_id: input.flowId,
    sequence_no: sequenceNo,
    node_id: input.nodeId,
    attempt_id: input.attemptId,
    session_id: input.sessionId,
    event_type: input.eventType,
    event_version: input.eventVersion,
    payload_sha256: unsigned.payloadSha256,
    previous_event_sha256: previousEventSha256,
    event_sha256: sha256(canonicalJson(unsigned)),
    trace_id: input.traceId,
    span_id: input.spanId,
    created_at: input.createdAt,
  };
};

const expectedUsageReceipt = (input: JsonObject): JsonObject => {
  const usage = input.normalizedUsage as JsonObject;
  const coveredAttemptIds = input.coveredAttemptIds as string[];
  return {
    schemaVersion: "UsageReceipt/v1",
    flowId: input.flowId,
    usageId: input.usageId,
    attemptId: input.attemptId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    receiptId: input.receiptId,
    scope: input.scope,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    costMicroUsd: usage.costMicroUsd,
    completeness: usage.status,
    provenance: usage.provenance,
    coverageCount: coveredAttemptIds.length,
    coverageSha256: sha256(canonicalJson(coveredAttemptIds)),
    createdAt: input.createdAt,
  };
};

const usageEventInput = (input: JsonObject): JsonObject => ({
  eventId: input.usageId,
  flowId: input.flowId,
  nodeId: input.nodeId,
  attemptId: input.attemptId,
  sessionId: input.sessionId,
  eventType: "attempt_usage_recorded",
  eventVersion: "1",
  payload: {
    schemaVersion: "TelemetryPayload/v1",
    parentSessionId: null,
    data: expectedUsageReceipt(input),
  },
  parentSessionId: null,
  traceId: null,
  spanId: null,
  createdAt: input.createdAt,
});

const expectedUsageRow = (input: JsonObject): JsonObject => {
  const usage = input.normalizedUsage as JsonObject;
  const payloadJson = canonicalJson(usageEventInput(input).payload);
  return {
    usage_id: input.usageId,
    flow_id: input.flowId,
    attempt_id: input.attemptId,
    provider: input.provider,
    provider_session_id: input.providerSessionId,
    receipt_id: input.receiptId,
    scope: input.scope,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cost_microusd: usage.costMicroUsd,
    completeness: usage.status,
    receipt_sha256: sha256(payloadJson),
    created_at: input.createdAt,
  };
};

const expectedRootSessionRow = (
  status: "running" | "terminal" | "orphaned",
  terminalAt: number | null,
): JsonObject => ({
  session_id: "session-a",
  flow_id: "flow-a",
  attempt_id: "attempt-a",
  parent_session_id: null,
  provider_session_ref: canonicalJson({
    schemaVersion: "ProviderSessionRef/v1",
    value: "provider-session-a",
    provenance: "provider_reported",
  }),
  kind: "node_attempt",
  status,
  created_at: 1_000,
  terminal_at: terminalAt,
});

const terminalEventInput = (input: JsonObject): JsonObject => ({
  eventId: sha256(canonicalJson({
    flowId: input.flowId,
    attemptId: input.attemptId,
    eventVersion: "1",
  })),
  flowId: input.flowId,
  nodeId: input.nodeId,
  attemptId: input.attemptId,
  sessionId: input.sessionId,
  eventType: "attempt_terminal",
  eventVersion: "1",
  payload: {
    schemaVersion: "TelemetryPayload/v1",
    parentSessionId: null,
    data: {
      schemaVersion: "AttemptTerminalReceipt/v1",
      flowId: input.flowId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      provider: input.provider,
      attemptOrdinal: input.attemptOrdinal,
      outcome: input.outcome,
      errorClassification: input.errorClassification,
      startedAt: input.startedAt,
      terminalAt: input.terminalAt,
      usageObservation: input.usageObservation,
    },
  },
  parentSessionId: null,
  traceId: null,
  spanId: null,
  createdAt: input.terminalAt,
});

const terminalizeAttempt = (
  state: TelemetryFixture,
  status: "succeeded" | "failed" | "cancelled" = "succeeded",
  overrides: Partial<Parameters<typeof terminalizeGraphAttempt>[1]> = {},
): void => terminalizeGraphAttempt(state.databasePath, {
  flowId: "flow-a",
  nodeId: "node-a",
  attemptId: "attempt-a",
  status,
  terminalAt: 1_400,
  ...overrides,
});

const graphExecutionRows = (rows: ReturnType<typeof telemetryRows>): JsonObject => ({
  collaboration_runs: rows.collaboration_runs,
  collaboration_dispatch_outbox: rows.collaboration_dispatch_outbox,
  runs: rows.runs,
  graph_flows: rows.graph_flows,
  graph_nodes: rows.graph_nodes,
  graph_edges: rows.graph_edges,
  graph_edge_evaluations: rows.graph_edge_evaluations,
  graph_node_admission_intents: rows.graph_node_admission_intents,
  graph_node_attempts: rows.graph_node_attempts,
  graph_node_admissions: rows.graph_node_admissions,
  graph_node_input_bindings: rows.graph_node_input_bindings,
  graph_node_results: rows.graph_node_results,
  graph_budget_reservations: rows.graph_budget_reservations,
  graph_budget_settlements: rows.graph_budget_settlements,
});

interface WorkerResult { ok: boolean; result?: JsonObject; error?: string }

async function terminateWorkerBounded(worker: Worker): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      worker.terminate().then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("telemetry worker termination timed out")), 5_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function raceWorkers(
  databasePath: string,
  method: string,
  inputs: readonly JsonObject[],
): Promise<WorkerResult[]> {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const sync = new Int32Array(barrier);
  const workers = inputs.map((input) => new Worker(
    new URL("./fixtures/flow-telemetry-worker.mjs", import.meta.url),
    { workerData: { databasePath, method, input, barrier }, execArgv: ["--import", "tsx"] },
  ));
  const results = workers.map((worker) => new Promise<WorkerResult>((resolveResult, reject) => {
    let settled = false;
    worker.once("message", (message: WorkerResult) => {
      settled = true;
      resolveResult(message);
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`telemetry race worker exited without a result (${code})`));
    });
  }));
  let completionTimer: NodeJS.Timeout | undefined;
  try {
    const barrierDeadline = Date.now() + 5_000;
    while (Atomics.load(sync, 0) !== inputs.length) {
      if (Date.now() >= barrierDeadline) throw new Error("telemetry race workers did not reach their barrier");
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    Atomics.store(sync, 1, 1);
    Atomics.notify(sync, 1, inputs.length);
    return await Promise.race([
      Promise.all(results),
      new Promise<never>((_resolve, reject) => {
        completionTimer = setTimeout(() => reject(new Error("telemetry race workers did not complete")), 10_000);
      }),
    ]);
  } finally {
    if (completionTimer !== undefined) clearTimeout(completionTimer);
    Atomics.store(sync, 1, 1);
    Atomics.notify(sync, 1, inputs.length);
    await Promise.allSettled(workers.map(terminateWorkerBounded));
  }
}

describe("FlowTelemetryStore session lifecycle", () => {
  it("binds root and child ancestry, canonicalizes a set-once provider ref, and rejects cycles or timestamp drift", async () => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    const graphBefore = graphExecutionRows(telemetryRows(state.databasePath));
    expect(store.createSession({
      sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: null, kind: "node_attempt", createdAt: 1_000,
    })).toEqual({ sessionId: "session-a", replayed: false });
    const created = telemetryRows(state.databasePath);
    expect(store.createSession({
      sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: null, kind: "node_attempt", createdAt: 1_000,
    })).toEqual({ sessionId: "session-a", replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(created);
    expect(() => store.createSession({
      sessionId: "wrong-root", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: null, kind: "node_attempt", createdAt: 1_000,
    })).toThrow(/attempt.*session|root.*binding/i);
    expect(() => store.createSession({
      sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: "missing-parent", kind: "coordination", createdAt: 999,
    })).toThrow(/parent|ancestry|time/i);

    expect(store.transitionSession({
      flowId: "flow-a", sessionId: "session-a", expectedStatus: "created", status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "provider-session-a", provenance: "provider_reported",
      },
      now: 1_100,
    })).toEqual({ sessionId: "session-a", status: "running", replayed: false });
    const providerSessionRef = telemetryRows(state.databasePath).agent_sessions!
      .find(({ session_id }) => session_id === "session-a")!.provider_session_ref;
    expect(providerSessionRef).toBe(canonicalJson({
      schemaVersion: "ProviderSessionRef/v1",
      value: "provider-session-a",
      provenance: "provider_reported",
    }));
    expect(Object.keys(JSON.parse(String(providerSessionRef)) as JsonObject).sort()).toEqual([
      "provenance", "schemaVersion", "value",
    ]);
    expect(store.createSession({
      sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: "session-a", kind: "coordination", createdAt: 1_101,
    })).toEqual({ sessionId: "session-child", replayed: false });
    expect(() => store.createSession({
      sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: "session-child", kind: "node_attempt", createdAt: 1_102,
    })).toThrow(/immutable|cycle|conflict|ancestry/i);
    expect(() => store.transitionSession({
      flowId: "flow-a", sessionId: "session-a", expectedStatus: "running", status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "other", provenance: "command_pinned",
      },
      now: 1_200,
    })).toThrow(/provider.*immutable|set.once|conflict/i);
    expect(() => store.transitionSession({
      flowId: "flow-a", sessionId: "session-child", expectedStatus: "created", status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "child", provenance: "caller_supplied",
      },
      now: 1_200,
    })).toThrow(/provenance|provider/i);
    expect(graphExecutionRows(telemetryRows(state.databasePath))).toEqual(graphBefore);
    store.close();
  });

  it("replays the immutable session creation after running and terminal lifecycle advances", async () => {
    const Store = await loadStore();
    const state = fixture();
    const creation = {
      sessionId: "session-a",
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: null,
      kind: "node_attempt",
      createdAt: 1_000,
    };
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });

    const running = telemetryRows(state.databasePath);
    expect(store.createSession(creation)).toEqual({ sessionId: "session-a", replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(running);

    store.recordUsage(exactUsage());
    terminalizeAttempt(state);
    store.recordAttemptTerminal(terminalInput());
    const terminal = telemetryRows(state.databasePath);
    expect(terminal.agent_sessions).toEqual([
      expect.objectContaining({
        session_id: "session-a",
        provider_session_ref: canonicalJson({
          schemaVersion: "ProviderSessionRef/v1",
          value: "provider-session-a",
          provenance: "provider_reported",
        }),
        status: "terminal",
        created_at: 1_000,
        terminal_at: 1_400,
      }),
    ]);
    expect(terminal.agent_attempt_usage).toHaveLength(1);
    expect(terminal.agent_events).toHaveLength(2);
    store.close();

    store = new Store(state.databasePath);
    expect(store.createSession(creation)).toEqual({ sessionId: "session-a", replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(terminal);
    store.close();
  });

  it("serializes concurrent identical creation replays after running and rejects one conflicting identity", async () => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.close();
    const before = telemetryRows(state.databasePath);
    const creation = {
      sessionId: "session-a",
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: null,
      kind: "node_attempt",
      createdAt: 1_000,
    };

    const results = await raceWorkers(state.databasePath, "createSession", [
      creation,
      structuredClone(creation),
      { ...creation, kind: "coordination" },
    ]);
    expect(results.slice(0, 2)).toEqual([
      { ok: true, result: { sessionId: "session-a", replayed: true } },
      { ok: true, result: { sessionId: "session-a", replayed: true } },
    ]);
    expect(results[2]).toEqual({
      ok: false,
      error: expect.stringMatching(/session replay|immutable|conflict/i),
    });
    expect(telemetryRows(state.databasePath)).toEqual(before);

    store = new Store(state.databasePath);
    expect(store.createSession(creation)).toEqual({ sessionId: "session-a", replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it.each([
    { label: "flow", override: { flowId: "flow-b" } },
    { label: "attempt", override: { attemptId: null } },
    { label: "parent", override: { parentSessionId: "session-other" } },
    { label: "kind", override: { kind: "coordination" } },
    { label: "createdAt", override: { createdAt: 1_001 } },
  ])("rejects a conflicting immutable session $label after terminal reopen with zero mutation", async ({ override }) => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    terminalizeAttempt(state, "failed");
    store.recordAttemptTerminal(terminalInput({
      outcome: "provider_failure",
      errorClassification: "provider_error",
      usageObservation: { status: "unavailable", usageId: null },
    }));
    store.close();

    store = new Store(state.databasePath);
    const before = telemetryRows(state.databasePath);
    expect(() => store.createSession({
      sessionId: "session-a",
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: null,
      kind: "node_attempt",
      createdAt: 1_000,
      ...override,
    })).toThrow(/session replay|immutable|conflict/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it("rejects missing, cross-flow, retrocausal, mutable ancestry and malformed provider refs independently", async () => {
    const Store = await loadStore();
    const ancestryCases: Array<{
      label: string;
      arrange: (store: FlowTelemetryStore, state: TelemetryFixture) => void;
      input: JsonObject;
    }> = [
      {
        label: "canonical attempt session with non-node kind",
        arrange: () => undefined,
        input: {
          sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
          parentSessionId: null, kind: "coordination", createdAt: 1_000,
        },
      },
      {
        label: "missing parent",
        arrange: () => undefined,
        input: {
          sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
          parentSessionId: "missing-parent", kind: "coordination", createdAt: 1_101,
        },
      },
      {
        label: "retrocausal timestamp",
        arrange: (store) => createRootSession(store, { createdAt: 1_000 }),
        input: {
          sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
          parentSessionId: "session-a", kind: "coordination", createdAt: 999,
        },
      },
      {
        label: "cross-flow parent",
        arrange: (store) => {
          createRootSession(store, { createdAt: 1_000 });
          createRootSession(store, {
            flowId: "flow-b", attemptId: "attempt-other", sessionId: "session-other",
            providerSessionId: "provider-session-other", createdAt: 1_000,
          });
        },
        input: {
          sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
          parentSessionId: "session-other", kind: "coordination", createdAt: 1_101,
        },
      },
      {
        label: "immutable parent",
        arrange: (store) => {
          createRootSession(store, { createdAt: 1_000 });
          store.createSession({
            sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
            parentSessionId: "session-a", kind: "coordination", createdAt: 1_101,
          });
        },
        input: {
          sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
          parentSessionId: null, kind: "coordination", createdAt: 1_101,
        },
      },
    ];
    for (const candidate of ancestryCases) {
      const state = fixture();
      const store = new Store(state.databasePath);
      candidate.arrange(store, state);
      const before = telemetryRows(state.databasePath);
      expect(() => store.createSession(candidate.input), candidate.label)
        .toThrow(/parent|ancestry|causal|time|immutable|conflict|flow|kind|attempt|binding/i);
      expect(telemetryRows(state.databasePath), candidate.label).toEqual(before);
      store.close();
    }

    const invalidProviderRefs: Array<{ label: string; providerSessionRef: JsonObject }> = [
      { label: "missing schema", providerSessionRef: { value: "provider-a", provenance: "provider_reported" } },
      { label: "missing value", providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", provenance: "provider_reported",
      } },
      { label: "missing provenance", providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "provider-a",
      } },
      { label: "extra field", providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "provider-a", provenance: "provider_reported", extra: true,
      } },
      { label: "caller provenance", providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "provider-a", provenance: "caller_supplied",
      } },
    ];
    for (const candidate of invalidProviderRefs) {
      const state = fixture();
      const store = new Store(state.databasePath);
      store.createSession({
        sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
        parentSessionId: null, kind: "node_attempt", createdAt: 1_000,
      });
      const before = telemetryRows(state.databasePath);
      expect(() => store.transitionSession({
        flowId: "flow-a", sessionId: "session-a", expectedStatus: "created", status: "running",
        providerSessionRef: candidate.providerSessionRef,
        now: 1_100,
      }), candidate.label).toThrow(/provider|reference|schema|provenance|field/i);
      expect(telemetryRows(state.databasePath), candidate.label).toEqual(before);
      store.close();
    }
  });

  it("allows exactly one terminal-or-orphan CAS winner under a real two-worker race and preserves its timestamp", async () => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.close();
    const results = await raceWorkers(state.databasePath, "transitionSession", [
      { flowId: "flow-a", sessionId: "session-a", expectedStatus: "running", status: "terminal", now: 1_300 },
      { flowId: "flow-a", sessionId: "session-a", expectedStatus: "running", status: "orphaned", now: 1_301 },
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      expect.objectContaining({ error: expect.stringMatching(/CAS|state|terminal|orphan/i) }),
    ]);
    const winner = telemetryRows(state.databasePath).agent_sessions![0]!;
    expect(["terminal", "orphaned"]).toContain(winner.status);
    const terminalAt = winner.terminal_at;
    store = new Store(state.databasePath);
    expect(store.transitionSession({
      flowId: "flow-a", sessionId: "session-a", expectedStatus: winner.status,
      status: winner.status, now: Number(terminalAt) + 100,
    })).toMatchObject({ replayed: true });
    expect(telemetryRows(state.databasePath).agent_sessions![0]!.terminal_at).toBe(terminalAt);
    store.close();
  });

  it("rolls back a session transition fault and reopens without a phantom terminal state", async () => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.close();
    store = new Store(state.databasePath, {
      faultInjector: (point) => { if (point === "after_session_update") throw new Error("session fault"); },
    });
    expect(() => store.transitionSession({
      flowId: "flow-a", sessionId: "session-a", expectedStatus: "running", status: "terminal", now: 1_300,
    })).toThrow(/session fault/i);
    store.close();
    store = new Store(state.databasePath);
    expect(telemetryRows(state.databasePath).agent_sessions![0]).toEqual(expect.objectContaining({
      status: "running", terminal_at: null,
    }));
    store.close();
  });
});

describe("FlowTelemetryStore event ledger", () => {
  it("commits exact canonical header plus payload, validates causal linkage, and replays every projection", async () => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const graphBefore = graphExecutionRows(telemetryRows(state.databasePath));
    const first = store.appendEvent(eventInput());
    expect(first).toEqual({
      eventId: "event-a-1",
      sequenceNo: 1,
      eventSha256: expectedEventRow(eventInput(), 1, null).event_sha256,
      replayed: false,
    });
    const rows = telemetryRows(state.databasePath);
    const header = rows.agent_events![0]!;
    const payload = rows.agent_event_payloads![0]!;
    const expectedPayloadJson = canonicalJson(eventInput().payload);
    const expectedPayloadSha256 = sha256(expectedPayloadJson);
    expect(payload).toEqual({
      event_id: "event-a-1",
      payload_json: expectedPayloadJson,
      payload_sha256: expectedPayloadSha256,
    });
    expect(header).toEqual(expectedEventRow(eventInput(), 1, null));
    expect(store.appendEvent(eventInput())).toEqual({ ...first, replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(rows);
    expect(() => store.appendEvent(eventInput({
      payload: {
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: null,
        data: { state: "queued" },
      },
    }))).toThrow(/event.*conflict|immutable|payload|identity/i);
    expect(telemetryRows(state.databasePath)).toEqual(rows);
    expect(graphExecutionRows(rows)).toEqual(graphBefore);

    store.createSession({
      sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: "session-a", kind: "coordination", createdAt: 1_201,
    });
    store.transitionSession({
      flowId: "flow-a", sessionId: "session-child", expectedStatus: "created", status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1", value: "provider-child", provenance: "command_pinned",
      },
      now: 1_202,
    });
    expect(store.appendEvent(eventInput({
      eventId: "event-child",
      sessionId: "session-child",
      parentSessionId: "session-a",
      payload: {
        schemaVersion: "TelemetryPayload/v1", parentSessionId: "session-a", data: { state: "child" },
      },
      createdAt: 1_203,
    }))).toMatchObject({ sequenceNo: 2, replayed: false });

    const beforeRejected = telemetryRows(state.databasePath);
    for (const rejected of [
      eventInput({ attemptId: "attempt-b" }),
      eventInput({ flowId: "flow-b", nodeId: "node-other", attemptId: "attempt-other" }),
      eventInput({ parentSessionId: "session-b" }),
      eventInput({ payload: {
        schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data: { toolResult: "raw" },
      } }),
    ]) expect(() => store.appendEvent(rejected)).toThrow(/causal|cross.flow|parent|payload|forbidden|conflict/i);
    expect(telemetryRows(state.databasePath)).toEqual(beforeRejected);
    store.close();
  });

  it("persists only the exact generic-redacted payload and hashes those sanitized bytes", async () => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const graphBefore = graphExecutionRows(telemetryRows(state.databasePath));
    const raw = eventInput({
      payload: {
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: null,
        data: {
          message: "Authorization: Bearer STORE_DUMMY_TOKEN",
          metadata: { accessToken: "opaque-store-dummy", safe: "kept" },
        },
      },
    });
    const sanitized = eventInput({
      payload: {
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: null,
        data: {
          message: "Authorization: Bearer [REDACTED]",
          metadata: { accessToken: "[REDACTED]", safe: "kept" },
        },
      },
    });
    expect(store.appendEvent(raw)).toEqual({
      eventId: "event-a-1",
      sequenceNo: 1,
      eventSha256: expectedEventRow(sanitized, 1, null).event_sha256,
      replayed: false,
    });
    const rows = telemetryRows(state.databasePath);
    expect(rows.agent_events).toEqual([expectedEventRow(sanitized, 1, null)]);
    expect(rows.agent_event_payloads).toEqual([{
      event_id: "event-a-1",
      payload_json: canonicalJson(sanitized.payload),
      payload_sha256: sha256(canonicalJson(sanitized.payload)),
    }]);
    expect(String(rows.agent_event_payloads![0]!.payload_json)).not.toContain("STORE_DUMMY_TOKEN");
    expect(String(rows.agent_event_payloads![0]!.payload_json)).not.toContain("opaque-store-dummy");
    expect(graphExecutionRows(rows)).toEqual(graphBefore);
    store.close();
  });

  it.each([MAX_STABLE_ID_BYTES - 1, MAX_STABLE_ID_BYTES])(
    "accepts stable IDs at the %i-byte boundary with exact event and W3C trace/span maxima",
    async (eventIdBytes) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const eventId = "e".repeat(eventIdBytes);
    expect(store.appendEvent(eventInput({
      eventId,
      eventType: `e${"v".repeat(63)}`,
      eventVersion: "v".repeat(32),
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID,
    }))).toMatchObject({ eventId, sequenceNo: 1, replayed: false });
    store.close();
    },
  );

  it.each([
    ["overlong eventId", { eventId: "e".repeat(MAX_STABLE_ID_BYTES + 1) }],
    ["control eventId", { eventId: "event\nforged" }],
    ["overlong eventType", { eventType: `e${"v".repeat(64)}` }],
    ["invalid eventType alphabet", { eventType: "Attempt-Started" }],
    ["overlong eventVersion", { eventVersion: "v".repeat(33) }],
    ["invalid eventVersion alphabet", { eventVersion: "1/2" }],
  ] as const)("rejects %s before any durable or exported effect", async (_label, overrides) => {
    const Store = await loadStore();
    const state = fixture();
    const exported: Array<Readonly<JsonObject>> = [];
    const store = new Store(state.databasePath, {
      telemetryExporter: (payload) => { exported.push(payload); },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const before = telemetryRows(state.databasePath);
    expect(() => store.appendEvent(eventInput(overrides))).toThrow(/identity|ascii|length|bounded|event|safe|invalid/i);
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    expect(telemetryRows(state.databasePath)).toEqual(before);
    expect(exported).toEqual([]);
    store.close();
  });

  it.each([
    ["trace length", "f".repeat(31), VALID_SPAN_ID],
    ["zero trace", "0".repeat(32), VALID_SPAN_ID],
    ["uppercase trace", "F".repeat(32), VALID_SPAN_ID],
    ["span length", VALID_TRACE_ID, "f".repeat(15)],
    ["zero span", VALID_TRACE_ID, "0".repeat(16)],
    ["uppercase span", VALID_TRACE_ID, "F".repeat(16)],
  ] as const)("rejects invalid %s at the durable event seam", async (_label, traceId, spanId) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const before = telemetryRows(state.databasePath);
    expect(() => store.appendEvent(eventInput({ traceId, spanId }))).toThrow(/trace|span|hex|zero|invalid/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it.each([
    ["overlong session id", "s".repeat(MAX_STABLE_ID_BYTES + 1)],
    ["control session id", "session\rforged"],
  ] as const)("rejects %s before creating a coordination session", async (_label, sessionId) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const before = telemetryRows(state.databasePath);
    expect(() => store.createSession({
      sessionId,
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: "session-a",
      kind: "coordination",
      createdAt: 1_101,
    })).toThrow(/session|identity|ascii|length|bounded|safe|invalid/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it("rejects a session kind outside node_attempt or coordination", async () => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const before = telemetryRows(state.databasePath);
    expect(() => store.createSession({
      sessionId: "session-worker",
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: "session-a",
      kind: "worker",
      createdAt: 1_101,
    })).toThrow(/session kind|node_attempt|coordination|invalid/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it("accepts a printable Unicode provider session reference at exactly 256 UTF-8 bytes", async () => {
    const Store = await loadStore();
    const state = fixture();
    const providerSessionId = "é".repeat(MAX_PROVIDER_SESSION_REF_BYTES / 2);
    expect(Buffer.byteLength(providerSessionId, "utf8")).toBe(MAX_PROVIDER_SESSION_REF_BYTES);
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId });
    expect(store.recordUsage(exactUsage({ providerSessionId }))).toEqual({
      usageId: "usage-a-1",
      eventId: "usage-a-1",
      replayed: false,
    });
    store.close();
  });

  it.each([
    ["overlong provider session", "p".repeat(MAX_PROVIDER_SESSION_REF_BYTES + 1)],
    ["C0 provider session", "provider\nsession"],
    ["C1 provider session", `provider${String.fromCharCode(0x85)}session`],
    ["bidi provider session", "provider\u202esession"],
  ] as const)("rejects %s before a session transition", async (_label, providerSessionId) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    store.createSession({
      sessionId: "session-a",
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: null,
      kind: "node_attempt",
      createdAt: 1_000,
    });
    const before = telemetryRows(state.databasePath);
    expect(() => store.transitionSession({
      flowId: "flow-a",
      sessionId: "session-a",
      expectedStatus: "created",
      status: "running",
      providerSessionRef: {
        schemaVersion: "ProviderSessionRef/v1",
        value: providerSessionId,
        provenance: "provider_reported",
      },
      now: 1_100,
    })).toThrow(/provider session|control|bidi|length|bounded|printable|safe|invalid/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it.each(["codex", "grok", "claude"] as const)("accepts the exact provider enum value %s", async (provider) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    expect(store.recordUsage(exactUsage({ provider }))).toEqual({
      usageId: "usage-a-1",
      eventId: "usage-a-1",
      replayed: false,
    });
    store.close();
  });

  it("rejects a non-canonical provider before any usage write", async () => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const before = telemetryRows(state.databasePath);
    expect(() => store.recordUsage(exactUsage({ provider: "other-provider" })))
      .toThrow(/provider|codex|grok|claude|invalid/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it.each([
    ["provider session reference", "sk-sensitiveprovidersession123"],
    ["usage provider", "sk-sensitiveprovideridentity123"],
    ["usage receipt", "sk-sensitivereceiptidentity123"],
  ] as const)("rejects a secret-like %s before any durable or exported effect", async (identity, secret) => {
    const Store = await loadStore();
    const state = fixture();
    const exported: Array<Readonly<JsonObject>> = [];
    const store = new Store(state.databasePath, {
      telemetryExporter: (payload) => { exported.push(payload); },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });

    let rejected: () => unknown;
    if (identity === "provider session reference") {
      store.createSession({
        sessionId: "session-safe-control", flowId: "flow-a", attemptId: "attempt-a",
        parentSessionId: "session-a", kind: "coordination", createdAt: 1_101,
      });
      expect(store.transitionSession({
        flowId: "flow-a", sessionId: "session-safe-control", expectedStatus: "created", status: "running",
        providerSessionRef: {
          schemaVersion: "ProviderSessionRef/v1", value: "safe-provider-session", provenance: "command_pinned",
        },
        now: 1_102,
      })).toMatchObject({ status: "running", replayed: false });
      store.createSession({
        sessionId: "session-sensitive-target", flowId: "flow-a", attemptId: "attempt-a",
        parentSessionId: "session-a", kind: "coordination", createdAt: 1_103,
      });
      rejected = () => store.transitionSession({
        flowId: "flow-a", sessionId: "session-sensitive-target", expectedStatus: "created", status: "running",
        providerSessionRef: {
          schemaVersion: "ProviderSessionRef/v1", value: secret, provenance: "provider_reported",
        },
        now: 1_104,
      });
    } else {
      expect(store.recordUsage(exactUsage({
        usageId: "usage-safe-control", receiptId: "receipt-safe-control",
      }))).toEqual({ usageId: "usage-safe-control", eventId: "usage-safe-control", replayed: false });
      rejected = () => store.recordUsage(exactUsage({
        usageId: `usage-rejected-${identity === "usage provider" ? "provider" : "receipt"}`,
        provider: identity === "usage provider" ? secret : "codex",
        receiptId: identity === "usage receipt" ? secret : "receipt-rejected-control",
        createdAt: 1_301,
      }));
    }

    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    const before = telemetryRows(state.databasePath);
    const exportedBefore = [...exported];
    expect(() => rejected(), identity).toThrow(/sensitive value.*telemetry identity|exactly codex.*grok.*claude/i);
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    expect(telemetryRows(state.databasePath)).toEqual(before);
    expect(exported).toEqual(exportedBefore);
    expect(persistedDatabaseText(state.databasePath)).not.toContain(secret);
    expect(canonicalJson(exported)).not.toContain(secret);
    expect(existsSync(join(dirname(state.databasePath), "telemetry-archives"))).toBe(false);
    store.close();
  });

  it.each(["eventId", "sessionId", "eventType"] as const)(
    "rejects a secret-like %s header before DB, archive, or export effects",
    async (identity) => {
      const Store = await loadStore();
      const state = fixture();
      const exported: Array<Readonly<JsonObject>> = [];
      const store = new Store(state.databasePath, {
        telemetryExporter: (payload) => { exported.push(payload); },
      });
      createRootSession(store, { providerSessionId: "provider-session-a" });
      const secret = "ghp_abcdefghijklmno";
      const before = telemetryRows(state.databasePath);
      const rejected = identity === "sessionId"
        ? () => store.createSession({
          sessionId: secret,
          flowId: "flow-a",
          attemptId: "attempt-a",
          parentSessionId: "session-a",
          kind: "coordination",
          createdAt: 1_101,
        })
        : () => store.appendEvent(eventInput(identity === "eventId"
          ? { eventId: secret }
          : { eventType: secret }));

      expect(rejected).toThrow(/sensitive|telemetry identity|secret/i);
      await new Promise<void>((resolveWait) => setImmediate(resolveWait));
      expect(telemetryRows(state.databasePath)).toEqual(before);
      expect(exported).toEqual([]);
      expect(persistedDatabaseText(state.databasePath)).not.toContain(secret);
      expect(existsSync(join(dirname(state.databasePath), "telemetry-archives"))).toBe(false);
      store.close();
    },
  );

  it("rejects a self-consistent persisted child session-kind policy violation on reopen", async () => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.createSession({
      sessionId: "session-child-kind",
      flowId: "flow-a",
      attemptId: "attempt-a",
      parentSessionId: "session-a",
      kind: "coordination",
      createdAt: 1_101,
    });
    store.close();
    const db = new Database(state.databasePath);
    try {
      db.prepare("UPDATE agent_sessions SET kind='worker' WHERE session_id='session-child-kind'").run();
    } finally {
      db.close();
    }

    const tampered = telemetryRows(state.databasePath);
    let reopened: FlowTelemetryStore | undefined;
    try {
      expect(() => { reopened = new Store(state.databasePath); })
        .toThrow(/session kind.*(node_attempt|coordination|policy|invalid)|invalid.*session kind/i);
      expect(telemetryRows(state.databasePath)).toEqual(tampered);
    } finally {
      reopened?.close();
    }
  });

  it.each([
    ["flowId", "event flow id", (value: string): JsonObject => eventInput({ flowId: value })],
    ["nodeId", "event node id", (value: string): JsonObject => eventInput({ nodeId: value })],
    ["attemptId", "event attempt id", (value: string): JsonObject => eventInput({ attemptId: value })],
    ["parentSessionId", "event parent session id", (value: string): JsonObject => eventInput({
      parentSessionId: value,
      payload: { schemaVersion: "TelemetryPayload/v1", parentSessionId: value, data: { state: "running" } },
    })],
    ["usageId", "usage id", (value: string): JsonObject => exactUsage({ usageId: value })],
    ["receiptId", "usage provider receipt id", (value: string): JsonObject => exactUsage({ receiptId: value })],
  ] as const)("rejects an invalid durable %s at the real store seam with zero effect", async (
    field,
    errorLabel,
    inputFor,
  ) => {
    const Store = await loadStore();
    const state = fixture();
    const exported: Array<Readonly<JsonObject>> = [];
    const store = new Store(state.databasePath, {
      telemetryExporter: (payload) => { exported.push(payload); },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const invalid = "i".repeat(MAX_STABLE_ID_BYTES + 1);
    const before = telemetryRows(state.databasePath);
    const operation = field === "usageId" || field === "receiptId"
      ? () => store.recordUsage(inputFor(invalid))
      : () => store.appendEvent(inputFor(invalid));
    expect(operation).toThrow(
      new RegExp(`${errorLabel}.*(identity|ascii|length|bounded|control|sensitive|safe|invalid)`, "i"),
    );
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    expect(telemetryRows(state.databasePath)).toEqual(before);
    expect(exported).toEqual([]);
    expect(persistedDatabaseText(state.databasePath)).not.toContain(invalid);
    expect(existsSync(join(dirname(state.databasePath), "telemetry-archives"))).toBe(false);
    store.close();
  });

  it("rejects parent-copy, immutable-parent, wrong-attempt and cross-flow event linkage as isolated causes", async () => {
    const Store = await loadStore();
    const cases: Array<{
      label: string;
      arrange: (store: FlowTelemetryStore, state: TelemetryFixture) => void;
      input: JsonObject;
    }> = [
      {
        label: "header and payload disagree",
        arrange: (store) => {
          createRootSession(store, { providerSessionId: "provider-session-a" });
          store.createSession({
            sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
            parentSessionId: "session-a", kind: "coordination", createdAt: 1_101,
          });
        },
        input: eventInput({
          sessionId: "session-child",
          parentSessionId: "session-a",
          payload: { schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data: { state: "child" } },
        }),
      },
      {
        label: "copies agree but differ from immutable parent",
        arrange: (store) => {
          createRootSession(store, { providerSessionId: "provider-session-a" });
          store.createSession({
            sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
            parentSessionId: "session-a", kind: "coordination", createdAt: 1_101,
          });
        },
        input: eventInput({
          sessionId: "session-child",
          parentSessionId: null,
          payload: { schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data: { state: "child" } },
        }),
      },
      {
        label: "same-flow wrong attempt session",
        arrange: (store, state) => {
          seedGraphAttempt(state.databasePath, {
            attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
            workflowId: "workflow-b", sessionId: "session-b",
          });
          createRootSession(store, { providerSessionId: "provider-session-a" });
          createRootSession(store, {
            attemptId: "attempt-b", sessionId: "session-b", providerSessionId: "provider-session-b", createdAt: 1_200,
          });
        },
        input: eventInput({ sessionId: "session-b" }),
      },
      {
        label: "cross-flow session",
        arrange: (store) => {
          createRootSession(store, { providerSessionId: "provider-session-a" });
          createRootSession(store, {
            flowId: "flow-b", attemptId: "attempt-other", sessionId: "session-other",
            providerSessionId: "provider-session-other",
          });
        },
        input: eventInput({ sessionId: "session-other" }),
      },
      {
        label: "node and attempt disagree",
        arrange: (store, state) => {
          seedGraphAttempt(state.databasePath, {
            attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
            workflowId: "workflow-b", sessionId: "session-b",
          });
          createRootSession(store, { providerSessionId: "provider-session-a" });
          createRootSession(store, {
            attemptId: "attempt-b", sessionId: "session-b", providerSessionId: "provider-session-b", createdAt: 1_200,
          });
        },
        input: eventInput({ attemptId: "attempt-b", sessionId: "session-b" }),
      },
    ];
    for (const candidate of cases) {
      const state = fixture();
      const store = new Store(state.databasePath);
      candidate.arrange(store, state);
      const before = telemetryRows(state.databasePath);
      expect(() => store.appendEvent(candidate.input), candidate.label)
        .toThrow(/causal|parent|session|attempt|node|flow|payload|foreign/i);
      expect(telemetryRows(state.databasePath), candidate.label).toEqual(before);
      store.close();
    }
  });

  it("allocates a contiguous chain under two writers, exact concurrent replay, and rollback", async () => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.close();
    const inputs = [
      eventInput({ eventId: "event-race-a", createdAt: 1_201 }),
      eventInput({ eventId: "event-race-b", createdAt: 1_202 }),
    ];
    const results = await raceWorkers(state.databasePath, "appendEvent", inputs);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(results.map(({ result }) => result!.sequenceNo).sort()).toEqual([1, 2]);
    let rows = telemetryRows(state.databasePath);
    expect(rows.agent_events!.map(({ sequence_no }) => sequence_no)).toEqual([1, 2]);
    expect(rows.agent_events![0]!.previous_event_sha256).toBe(null);
    expect(rows.agent_events![1]!.previous_event_sha256).toBe(rows.agent_events![0]!.event_sha256);

    const replayState = fixture();
    store = new Store(replayState.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.close();
    const replayResults = await raceWorkers(replayState.databasePath, "appendEvent", [inputs[0]!, inputs[0]!]);
    expect(replayResults.filter(({ result }) => result?.replayed === false)).toHaveLength(1);
    expect(replayResults.filter(({ result }) => result?.replayed === true)).toHaveLength(1);
    expect(telemetryRows(replayState.databasePath).agent_events).toHaveLength(1);

    store = new Store(state.databasePath, {
      faultInjector: (point) => { if (point === "after_agent_event_insert") throw new Error("event fault"); },
    });
    expect(() => store.appendEvent(eventInput({ eventId: "event-rollback" }))).toThrow(/event fault/i);
    store.close();
    store = new Store(state.databasePath);
    expect(store.appendEvent(eventInput({ eventId: "event-after-rollback", createdAt: 1_204 })))
      .toMatchObject({ sequenceNo: 3 });
    rows = telemetryRows(state.databasePath);
    expect(rows.agent_events!.map(({ sequence_no }) => sequence_no)).toEqual([1, 2, 3]);
    expect(rows.agent_event_payloads).toHaveLength(3);
    store.close();
  });

  it("provides the same bytes for every write through standalone IMMEDIATE and one issued outer transaction", async () => {
    const Store = await loadStore();
    const standalone = fixture();
    terminalizeAttempt(standalone);
    let store = new Store(standalone.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.appendEvent(eventInput());
    store.recordUsage(exactUsage());
    store.recordAttemptTerminal(terminalInput());
    store.close();

    const joined = fixture();
    terminalizeAttempt(joined);
    const lease = openStateDatabaseLease(joined.databasePath, "mutating_service");
    const access = lease.borrow();
    store = new Store(access);
    access.database.transaction(() => {
      store.createSessionInTransaction(access, {
        sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
        parentSessionId: null, kind: "node_attempt", createdAt: 1_000,
      });
      store.transitionSessionInTransaction(access, {
        flowId: "flow-a", sessionId: "session-a", expectedStatus: "created", status: "running",
        providerSessionRef: {
          schemaVersion: "ProviderSessionRef/v1", value: "provider-session-a", provenance: "provider_reported",
        },
        now: 1_100,
      });
      store.appendEventInTransaction(access, eventInput());
      store.recordUsageInTransaction(access, exactUsage());
      store.recordAttemptTerminalInTransaction(access, terminalInput());
    }).immediate();
    expect(telemetryRows(joined.databasePath)).toEqual(telemetryRows(standalone.databasePath));
    store.close();
    access.close();
    lease.close();
  });

  it("rolls back all five joined writes and rejects every primitive through outside, forged, or closed access", async () => {
    const Store = await loadStore();
    const state = fixture();
    terminalizeAttempt(state);
    const lease = openStateDatabaseLease(state.databasePath, "mutating_service");
    const access = lease.borrow();
    const store = new Store(access);
    const before = telemetryRows(state.databasePath);
    expect(() => access.database.transaction(() => {
      store.createSessionInTransaction(access, {
        sessionId: "session-a", flowId: "flow-a", attemptId: "attempt-a",
        parentSessionId: null, kind: "node_attempt", createdAt: 1_000,
      });
      store.transitionSessionInTransaction(access, {
        flowId: "flow-a", sessionId: "session-a", expectedStatus: "created", status: "running",
        providerSessionRef: {
          schemaVersion: "ProviderSessionRef/v1", value: "provider-session-a", provenance: "provider_reported",
        },
        now: 1_100,
      });
      store.appendEventInTransaction(access, eventInput());
      store.recordUsageInTransaction(access, exactUsage());
      store.recordAttemptTerminalInTransaction(access, terminalInput());
      throw new Error("outer transaction fault");
    }).immediate()).toThrow(/outer transaction fault/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);

    createRootSession(store, { providerSessionId: "provider-session-a" });
    const beforeAccessRejection = telemetryRows(state.databasePath);
    const createInput = {
      sessionId: "session-child", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: "session-a", kind: "coordination", createdAt: 1_200,
    };
    const transitionInput = {
      flowId: "flow-a", sessionId: "session-a", expectedStatus: "running", status: "terminal", now: 1_400,
    };
    const outsideCases = [
      () => store.createSessionInTransaction(access, createInput),
      () => store.transitionSessionInTransaction(access, transitionInput),
      () => store.appendEventInTransaction(access, eventInput({ eventId: "outside-event" })),
      () => store.recordUsageInTransaction(access, exactUsage({ usageId: "outside-usage" })),
      () => store.recordAttemptTerminalInTransaction(access, terminalInput()),
    ];
    for (const invoke of outsideCases) expect.soft(invoke).toThrow(/transaction|in.transaction/i);
    expect(telemetryRows(state.databasePath)).toEqual(beforeAccessRejection);

    const forged = Object.create(access) as StateDatabaseAccess;
    const forgedCases = [
      () => store.createSessionInTransaction(forged, createInput),
      () => store.transitionSessionInTransaction(forged, transitionInput),
      () => store.appendEventInTransaction(forged, eventInput({ eventId: "forged-event" })),
      () => store.recordUsageInTransaction(forged, exactUsage({ usageId: "forged-usage" })),
      () => store.recordAttemptTerminalInTransaction(forged, terminalInput()),
    ];
    for (const invoke of forgedCases) expect.soft(invoke).toThrow(/issued|access|capability|transaction/i);
    expect(telemetryRows(state.databasePath)).toEqual(beforeAccessRejection);

    access.close();
    const closedCases = [
      () => store.createSessionInTransaction(access, createInput),
      () => store.transitionSessionInTransaction(access, transitionInput),
      () => store.appendEventInTransaction(access, eventInput({ eventId: "closed-event" })),
      () => store.recordUsageInTransaction(access, exactUsage({ usageId: "closed-usage" })),
      () => store.recordAttemptTerminalInTransaction(access, terminalInput()),
    ];
    for (const invoke of closedCases) expect.soft(invoke).toThrow(/closed|revoked|access|lease/i);
    expect(telemetryRows(state.databasePath)).toEqual(beforeAccessRejection);
    store.close();
    lease.close();
  });

  it("rejects historical header tamper and a physically deleted middle chain member on reopen", async () => {
    const Store = await loadStore();
    const mutations: Array<{ label: string; mutate: (db: Database.Database) => void }> = [
      {
        label: "header changes without its digest",
        mutate: (db) => { db.prepare("UPDATE agent_events SET trace_id='tampered' WHERE sequence_no=1").run(); },
      },
      {
        label: "middle member is physically removed",
        mutate: (db) => {
          db.exec("DELETE FROM agent_event_payloads WHERE event_id='event-a-2'; DELETE FROM agent_events WHERE event_id='event-a-2'");
        },
      },
      {
        label: "wrong previous link has a self-consistent replacement event digest",
        mutate: (db) => {
          const wrongPrevious = "0".repeat(64);
          const unsigned = expectedUnsignedEvent(
            eventInput({ eventId: "event-a-2", createdAt: 1_202 }),
            2,
            wrongPrevious,
          );
          db.prepare(`UPDATE agent_events SET previous_event_sha256=?,event_sha256=?
            WHERE flow_id='flow-a' AND sequence_no=2`).run(
              wrongPrevious,
              sha256(canonicalJson(unsigned)),
            );
        },
      },
    ];
    for (const candidate of mutations) {
      const state = fixture();
      let store = new Store(state.databasePath);
      createRootSession(store, { providerSessionId: "provider-session-a" });
      for (let index = 1; index <= 3; index += 1) {
        store.appendEvent(eventInput({ eventId: `event-a-${index}`, createdAt: 1_200 + index }));
      }
      store.close();
      const db = new Database(state.databasePath);
      db.pragma("foreign_keys = OFF");
      candidate.mutate(db);
      db.close();
      expect(() => { store = new Store(state.databasePath); }, candidate.label)
        .toThrow(/tamper|hash|integrity|chain|gap|sequence|trace|span|hex/i);
    }
  });

  it("dispatches from the standalone store consumer only after commit and return, with zero effect on commit failure", async () => {
    const Store = await loadStore();
    const state = fixture();
    let appendReturned = false;
    let observedAfterCommit = false;
    let observedPayload: Readonly<JsonObject> | undefined;
    const invocationStates: boolean[] = [];
    let store = new Store(state.databasePath, {
      telemetryExportTimeoutMs: 20,
      telemetryExporter: (payload) => {
        invocationStates.push(appendReturned);
        observedPayload = payload;
        const db = new Database(state.databasePath, { readonly: true });
        observedAfterCommit = db.prepare("SELECT COUNT(*) FROM agent_events").pluck().get() === 1;
        db.close();
        throw new Error("optional exporter failed after observing commit");
      },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const outcome = store.appendEvent(eventInput());
    appendReturned = true;
    expect(outcome).toEqual({
      eventId: "event-a-1",
      sequenceNo: 1,
      eventSha256: expectedEventRow(eventInput(), 1, null).event_sha256,
      replayed: false,
    });
    store.close();
    const before = telemetryRows(state.databasePath);
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(invocationStates).toEqual([true]);
    expect(observedAfterCommit).toBe(true);
    expect(observedPayload).toEqual({
      schemaVersion: "TelemetryExport/v1",
      flowId: "flow-a",
      eventId: "event-a-1",
      sequenceNo: 1,
      eventType: "attempt_started",
      eventVersion: "1",
      eventSha256: expectedEventRow(eventInput(), 1, null).event_sha256,
      createdAt: 1_200,
    });
    expect(telemetryRows(state.databasePath)).toEqual(before);

    const failed = fixture();
    let failedExportCalls = 0;
    store = new Store(failed.databasePath, {
      faultInjector: (point) => { if (point === "after_agent_event_insert") throw new Error("commit fault"); },
      telemetryExportTimeoutMs: 20,
      telemetryExporter: () => { failedExportCalls += 1; },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const failedBefore = telemetryRows(failed.databasePath);
    expect(() => store.appendEvent(eventInput())).toThrow(/commit fault/i);
    store.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    expect(failedExportCalls).toBe(0);
    expect(telemetryRows(failed.databasePath)).toEqual(failedBefore);
  });
});

describe("FlowTelemetryStore usage receipt", () => {
  it("atomically persists the exact wrapped receipt, projection, digest, and sorted subtree coverage", async () => {
    const Store = await loadStore();
    const state = fixture();
    seedGraphAttempt(state.databasePath, {
      attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
      workflowId: "workflow-b", sessionId: "session-b",
    });
    seedGraphAttempt(state.databasePath, {
      attemptId: "attempt-c", flowId: "flow-a", nodeId: "node-c", attemptNo: 1,
      workflowId: "workflow-c", sessionId: "session-c",
    });
    const graphBefore = graphExecutionRows(telemetryRows(state.databasePath));
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const input = exactUsage({
      scope: "subtree",
      coveredAttemptIds: ["attempt-b", "attempt-c"],
    });
    expect(store.recordUsage(input)).toEqual({ usageId: "usage-a-1", eventId: "usage-a-1", replayed: false });
    const rows = telemetryRows(state.databasePath);
    const event = usageEventInput(input);
    const wrapper = event.payload as JsonObject;
    const payloadJson = canonicalJson(wrapper);
    const payloadSha256 = sha256(payloadJson);
    expect(rows.agent_events).toEqual([expectedEventRow(event, 1, null)]);
    expect(rows.agent_event_payloads).toEqual([{
      event_id: "usage-a-1",
      payload_json: payloadJson,
      payload_sha256: payloadSha256,
    }]);
    expect(rows.agent_usage_coverage).toEqual([
      { flow_id: "flow-a", usage_id: "usage-a-1", covered_attempt_id: "attempt-b" },
      { flow_id: "flow-a", usage_id: "usage-a-1", covered_attempt_id: "attempt-c" },
    ]);
    expect(JSON.parse(String(rows.agent_event_payloads![0]!.payload_json))).toEqual(wrapper);
    expect(rows.agent_attempt_usage).toEqual([{
      usage_id: "usage-a-1",
      flow_id: "flow-a",
      attempt_id: "attempt-a",
      provider: "codex",
      provider_session_id: "provider-session-a",
      receipt_id: "provider-receipt-a-1",
      scope: "subtree",
      input_tokens: 10,
      output_tokens: 5,
      cost_microusd: 4_200,
      completeness: "exact",
      receipt_sha256: payloadSha256,
      created_at: 1_300,
    }]);
    expect(graphExecutionRows(rows)).toEqual(graphBefore);
    const committed = telemetryRows(state.databasePath);
    expect(store.recordUsage(exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-b", "attempt-c"] })))
      .toEqual({ usageId: "usage-a-1", eventId: "usage-a-1", replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(committed);
    expect(() => store.recordUsage(exactUsage({
      scope: "subtree",
      coveredAttemptIds: ["attempt-b", "attempt-c"],
      normalizedUsage: {
        ...(exactUsage().normalizedUsage as JsonObject),
        provenance: { changed: "provider_reported" },
      },
    }))).toThrow(/conflict|provenance|immutable/i);
    expect(telemetryRows(state.databasePath)).toEqual(committed);
    expect(() => store.recordUsage(exactUsage({
      usageId: "usage-natural-identity-conflict",
      scope: "subtree",
      coveredAttemptIds: ["attempt-b", "attempt-c"],
    }))).toThrow(/natural|receipt|identity|conflict|immutable/i);
    expect(telemetryRows(state.databasePath)).toEqual(committed);
    store.close();

    const faulted = fixture();
    seedGraphAttempt(faulted.databasePath, {
      attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
      workflowId: "workflow-b", sessionId: "session-b",
    });
    store = new Store(faulted.databasePath, {
      faultInjector: (point) => { if (point === "after_usage_row_insert") throw new Error("usage fault"); },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });
    expect(() => store.recordUsage(exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-b"] })))
      .toThrow(/usage fault/i);
    store.close();
    const faultedRows = telemetryRows(faulted.databasePath);
    expect(faultedRows.agent_events).toEqual([]);
    expect(faultedRows.agent_event_payloads).toEqual([]);
    expect(faultedRows.agent_attempt_usage).toEqual([]);
    expect(faultedRows.agent_usage_coverage).toEqual([]);
  });

  it.each([
    ["partial", partialUsage, 10, 5, "partial"],
    ["unavailable", unavailableUsage, null, null, "unavailable"],
  ] as const)("persists the complete canonical %s receipt without invented numeric values", async (
    _label,
    usageFactory,
    inputTokens,
    outputTokens,
    completeness,
  ) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const input = usageFactory();
    const result = store.recordUsage(input);
    const event = usageEventInput(input);
    const payloadJson = canonicalJson(event.payload);
    const payloadSha256 = sha256(payloadJson);
    expect(result).toEqual({ usageId: input.usageId, eventId: input.usageId, replayed: false });
    const rows = telemetryRows(state.databasePath);
    expect(rows.agent_events).toEqual([expectedEventRow(event, 1, null)]);
    expect(rows.agent_event_payloads).toEqual([{
      event_id: input.usageId,
      payload_json: payloadJson,
      payload_sha256: payloadSha256,
    }]);
    expect(JSON.parse(String(rows.agent_event_payloads![0]!.payload_json))).toEqual(event.payload);
    expect(rows.agent_attempt_usage).toEqual([{
      usage_id: input.usageId,
      flow_id: "flow-a",
      attempt_id: "attempt-a",
      provider: "codex",
      provider_session_id: "provider-session-a",
      receipt_id: input.receiptId,
      scope: "self",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_microusd: null,
      completeness,
      receipt_sha256: payloadSha256,
      created_at: 1_300,
    }]);
    expect(rows.agent_usage_coverage).toEqual([]);
    store.close();
  });

  it("rejects invalid observations, malformed coverage, and cross-flow references with zero writes", async () => {
    const Store = await loadStore();
    const state = fixture();
    seedGraphAttempt(state.databasePath, {
      attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
      workflowId: "workflow-b", sessionId: "session-b",
    });
    seedGraphAttempt(state.databasePath, {
      attemptId: "attempt-c", flowId: "flow-a", nodeId: "node-c", attemptNo: 1,
      workflowId: "workflow-c", sessionId: "session-c",
    });
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    createRootSession(store, {
      attemptId: "attempt-b", sessionId: "session-b", providerSessionId: "provider-session-b", createdAt: 1_200,
    });
    const before = telemetryRows(state.databasePath);
    const rejected = [
      exactUsage({ normalizedUsage: { ...(exactUsage().normalizedUsage as JsonObject), status: "invalid_provider_usage" } }),
      exactUsage({ normalizedUsage: { ...(exactUsage().normalizedUsage as JsonObject), inputTokens: -1 } }),
      exactUsage({ normalizedUsage: { ...(exactUsage().normalizedUsage as JsonObject), outputTokens: 1.5 } }),
      exactUsage({ normalizedUsage: { ...(exactUsage().normalizedUsage as JsonObject), status: "exact", costMicroUsd: null } }),
      exactUsage({ normalizedUsage: { ...(exactUsage().normalizedUsage as JsonObject), status: "partial" } }),
      exactUsage({ normalizedUsage: {
        ...(exactUsage().normalizedUsage as JsonObject),
        status: "unavailable", inputTokens: 1, outputTokens: null, costMicroUsd: null,
      } }),
      exactUsage({ normalizedUsage: {
        ...(exactUsage().normalizedUsage as JsonObject),
        status: "partial", inputTokens: null, outputTokens: null, costMicroUsd: null,
      } }),
      exactUsage({ normalizedUsage: { ...(exactUsage().normalizedUsage as JsonObject), costMicroUsd: 4_201 } }),
      exactUsage({ scope: "self", coveredAttemptIds: ["attempt-b"] }),
      exactUsage({ scope: "subtree", coveredAttemptIds: [] }),
      exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-a"] }),
      exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-b", "attempt-b"] }),
      exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-c", "attempt-b"] }),
      exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-other"] }),
      exactUsage({
        nodeId: "node-b", attemptId: "attempt-b", sessionId: "session-b",
        usageId: "usage-b-ancestor", providerSessionId: "provider-session-b", receiptId: "receipt-b-ancestor",
        scope: "subtree", coveredAttemptIds: ["attempt-a"],
      }),
      exactUsage({
        nodeId: "node-b", attemptId: "attempt-b", sessionId: "session-b",
        usageId: "usage-b-sibling", providerSessionId: "provider-session-b", receiptId: "receipt-b-sibling",
        scope: "subtree", coveredAttemptIds: ["attempt-c"],
      }),
      exactUsage({ providerSessionId: "invented-provider-session" }),
    ];
    for (const input of rejected) expect(() => store.recordUsage(input)).toThrow(/usage|invalid|coverage|cross.flow|session/i);
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });

  it("detects DB tamper across wrapper, nested receipt, projection, coverage, time, and digest on reopen", async () => {
    const Store = await loadStore();
    const cases: Array<{ label: string; sql: string }> = [
      { label: "wrapper schemaVersion", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.schemaVersion','x')` },
      { label: "wrapper parentSessionId", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.parentSessionId','x')` },
      { label: "wrapper data", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data',json('{}'))` },
      { label: "receipt schemaVersion", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.schemaVersion','x')` },
      { label: "receipt flowId", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.flowId','x')` },
      { label: "receipt usageId", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.usageId','x')` },
      { label: "receipt attemptId", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.attemptId','x')` },
      { label: "receipt provider", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.provider','claude')` },
      { label: "receipt providerSessionId", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.providerSessionId','x')` },
      { label: "receipt receiptId", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.receiptId','x')` },
      { label: "receipt scope", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.scope','self')` },
      { label: "receipt inputTokens", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.inputTokens',999)` },
      { label: "receipt cachedInputTokens", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.cachedInputTokens',999)` },
      { label: "receipt outputTokens", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.outputTokens',999)` },
      { label: "receipt reasoningTokens", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.reasoningTokens',999)` },
      { label: "receipt totalTokens", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.totalTokens',999)` },
      { label: "receipt costUsd", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.costUsd',0.0043)` },
      { label: "receipt costMicroUsd", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.costMicroUsd',4300)` },
      { label: "receipt completeness", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.completeness','partial')` },
      { label: "receipt provenance", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.provenance',json('{}'))` },
      { label: "receipt coverageCount", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.coverageCount',2)` },
      { label: "receipt coverageSha256", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.coverageSha256',lower(hex(randomblob(32))))` },
      { label: "receipt createdAt", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.createdAt',999)` },
      ...[
        "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costUsd", "costMicroUsd",
      ].map((field) => ({
        label: `receipt provenance ${field}`,
        sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.provenance.${field}','x')`,
      })),
      { label: "payload digest", sql: `UPDATE agent_event_payloads SET payload_sha256=lower(hex(randomblob(32)))` },
      { label: "event header", sql: `UPDATE agent_events SET trace_id='tampered'` },
      { label: "event payload digest", sql: `UPDATE agent_events SET payload_sha256=lower(hex(randomblob(32)))` },
      { label: "projection usageId", sql: `UPDATE agent_attempt_usage SET usage_id='x'` },
      { label: "projection flowId", sql: `UPDATE agent_attempt_usage SET flow_id='flow-b'` },
      { label: "projection attemptId", sql: `UPDATE agent_attempt_usage SET attempt_id='attempt-other'` },
      { label: "projection provider", sql: `UPDATE agent_attempt_usage SET provider='claude'` },
      { label: "projection providerSessionId", sql: `UPDATE agent_attempt_usage SET provider_session_id='x'` },
      { label: "projection receiptId", sql: `UPDATE agent_attempt_usage SET receipt_id='x'` },
      { label: "projection scope", sql: `UPDATE agent_attempt_usage SET scope='self'` },
      { label: "projection inputTokens", sql: `UPDATE agent_attempt_usage SET input_tokens=999` },
      { label: "projection outputTokens", sql: `UPDATE agent_attempt_usage SET output_tokens=999` },
      { label: "projection costMicroUsd", sql: `UPDATE agent_attempt_usage SET cost_microusd=999` },
      { label: "projection completeness", sql: `UPDATE agent_attempt_usage SET completeness='partial'` },
      { label: "projection receiptSha256", sql: `UPDATE agent_attempt_usage SET receipt_sha256=lower(hex(randomblob(32)))` },
      { label: "projection createdAt", sql: `UPDATE agent_attempt_usage SET created_at=999` },
      { label: "coverage flowId", sql: `UPDATE agent_usage_coverage SET flow_id='flow-b'` },
      { label: "coverage usageId", sql: `UPDATE agent_usage_coverage SET usage_id='x'` },
      { label: "coverage coveredAttemptId", sql: `UPDATE agent_usage_coverage SET covered_attempt_id='attempt-a'` },
    ];
    for (const candidate of cases) {
      const state = fixture();
      seedGraphAttempt(state.databasePath, {
        attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
        workflowId: "workflow-b", sessionId: "session-b",
      });
      let store = new Store(state.databasePath);
      createRootSession(store, { providerSessionId: "provider-session-a" });
      store.recordUsage(exactUsage({ scope: "subtree", coveredAttemptIds: ["attempt-b"] }));
      store.close();
      const db = new Database(state.databasePath);
      db.pragma("foreign_keys = OFF");
      db.exec(candidate.sql);
      db.close();
      expect(() => { store = new Store(state.databasePath); }, candidate.label)
        .toThrow(/tamper|hash|integrity|coverage|receipt|projection|trace|span|hex/i);
    }
  }, 30_000);
});

describe("FlowTelemetryStore terminal receipts and isolation", () => {
  it.each([
    ["succeeded", null, "succeeded", { status: "exact", usageId: "usage-a-1" }],
    ["provider_failure", "provider_error", "failed", { status: "unavailable", usageId: null }],
    ["timeout", "timeout", "failed", { status: "unavailable", usageId: null }],
    ["malformed_terminal", "malformed_terminal", "failed", { status: "unavailable", usageId: null }],
  ] as const)("persists one exact %s terminal receipt only after its graph attempt is terminal", async (
    outcome, errorClassification, graphStatus, usageObservation,
  ) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    if (outcome === "succeeded") store.recordUsage(exactUsage());
    terminalizeAttempt(state, graphStatus);
    const input = terminalInput({ outcome, errorClassification, usageObservation });
    const first = store.recordAttemptTerminal(input);
    expect(first).toEqual({
      eventId: sha256(canonicalJson({ flowId: "flow-a", attemptId: "attempt-a", eventVersion: "1" })),
      replayed: false,
    });
    const rows = telemetryRows(state.databasePath);
    expect(rows.agent_sessions![0]).toEqual({
      session_id: "session-a",
      flow_id: "flow-a",
      attempt_id: "attempt-a",
      parent_session_id: null,
      provider_session_ref: canonicalJson({
        schemaVersion: "ProviderSessionRef/v1",
        value: "provider-session-a",
        provenance: "provider_reported",
      }),
      kind: "node_attempt",
      status: "terminal",
      created_at: 1_000,
      terminal_at: 1_400,
    });
    const eventRow = rows.agent_events!.at(-1)!;
    const payloadRow = rows.agent_event_payloads!.find(({ event_id }) => event_id === first.eventId)!;
    const expectedTerminalEvent = terminalEventInput(input);
    const sequenceNo = outcome === "succeeded" ? 2 : 1;
    const previousEventSha256 = outcome === "succeeded"
      ? expectedEventRow(usageEventInput(exactUsage()), 1, null).event_sha256 as string
      : null;
    expect(eventRow).toEqual(expectedEventRow(expectedTerminalEvent, sequenceNo, previousEventSha256));
    const expectedPayloadJson = canonicalJson(expectedTerminalEvent.payload);
    expect(payloadRow).toEqual({
      event_id: first.eventId,
      payload_json: expectedPayloadJson,
      payload_sha256: sha256(expectedPayloadJson),
    });
    expect(JSON.parse(String(payloadRow.payload_json))).toEqual(expectedTerminalEvent.payload);
    const committed = telemetryRows(state.databasePath);
    expect(store.recordAttemptTerminal(input)).toEqual({ ...first, replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(committed);
    expect(() => store.recordAttemptTerminal({ ...input, outcome: "cancelled", errorClassification: "cancelled" }))
      .toThrow(/terminal.*conflict|immutable|outcome/i);
    expect(telemetryRows(state.databasePath)).toEqual(committed);
    store.close();
  });

  it.each([
    ["partial with row", partialUsage, "succeeded", null, { status: "partial", usageId: "usage-a-partial" }],
    ["unavailable with row", unavailableUsage, "provider_failure", "provider_error",
      { status: "unavailable", usageId: "usage-a-unavailable" }],
    ["invalid provider usage without row", null, "provider_failure", "provider_error",
      { status: "invalid_provider_usage", usageId: null }],
  ] as const)("accepts the defined %s terminal usage path", async (
    _case, usageFactory, outcome, errorClassification, usageObservation,
  ) => {
    const Store = await loadStore();
    const state = fixture();
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    const usageInput = usageFactory === null ? null : usageFactory();
    if (usageInput !== null) store.recordUsage(usageInput);
    terminalizeAttempt(state, outcome === "succeeded" ? "succeeded" : "failed");
    const graphBeforeTerminalReceipt = graphExecutionRows(telemetryRows(state.databasePath));
    const input = terminalInput({ outcome, errorClassification, usageObservation });
    const result = store.recordAttemptTerminal(input);
    expect(result).toEqual({
      eventId: sha256(canonicalJson({ flowId: "flow-a", attemptId: "attempt-a", eventVersion: "1" })),
      replayed: false,
    });
    const rows = telemetryRows(state.databasePath);
    const terminalEvent = terminalEventInput(input);
    const usageEvent = usageInput === null ? null : usageEventInput(usageInput);
    const usageHeader = usageEvent === null ? null : expectedEventRow(usageEvent, 1, null);
    expect(rows.agent_sessions).toEqual([expectedRootSessionRow("terminal", 1_400)]);
    expect(rows.agent_events).toEqual(usageEvent === null ? [
      expectedEventRow(terminalEvent, 1, null),
    ] : [
      usageHeader,
      expectedEventRow(terminalEvent, 2, usageHeader!.event_sha256 as string),
    ]);
    expect(rows.agent_event_payloads).toEqual([
      ...(usageEvent === null ? [] : [{
        event_id: usageInput!.usageId,
        payload_json: canonicalJson(usageEvent.payload),
        payload_sha256: sha256(canonicalJson(usageEvent.payload)),
      }]),
      {
        event_id: result.eventId,
        payload_json: canonicalJson(terminalEvent.payload),
        payload_sha256: sha256(canonicalJson(terminalEvent.payload)),
      },
    ]);
    expect(rows.agent_attempt_usage).toEqual(usageInput === null ? [] : [expectedUsageRow(usageInput)]);
    expect(rows.agent_usage_coverage).toEqual([]);
    expect(graphExecutionRows(rows)).toEqual(graphBeforeTerminalReceipt);
    const committed = telemetryRows(state.databasePath);
    expect(store.recordAttemptTerminal(input)).toEqual({ ...result, replayed: true });
    expect(telemetryRows(state.databasePath)).toEqual(committed);
    store.close();
  });

  it("rejects a successful terminal without the required explicit unavailable receipt", async () => {
    const Store = await loadStore();
    const state = fixture();
    const exported: Array<Readonly<JsonObject>> = [];
    const store = new Store(state.databasePath, {
      telemetryExporter: (payload) => { exported.push(payload); },
    });
    createRootSession(store, { providerSessionId: "provider-session-a" });
    terminalizeAttempt(state, "succeeded");
    const before = telemetryRows(state.databasePath);
    expect(() => store.recordAttemptTerminal(terminalInput({
      usageObservation: { status: "unavailable", usageId: null },
    }))).toThrow(/successful terminal.*explicit usage receipt|unavailable.*receipt/i);
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
    expect(telemetryRows(state.databasePath)).toEqual(before);
    expect(exported).toEqual([]);
    store.close();
  });

  it("rejects each malformed fresh terminal input for its isolated cause with zero terminal writes", async () => {
    const Store = await loadStore();
    const invalid: Array<{
      label: string;
      mutate: (input: JsonObject) => JsonObject;
      leaveRunning?: boolean;
    }> = [
      { label: "running attempt", mutate: (input) => input, leaveRunning: true },
      { label: "flow", mutate: (input) => ({ ...input, flowId: "flow-b" }) },
      { label: "node", mutate: (input) => ({ ...input, nodeId: "node-b" }) },
      { label: "attempt", mutate: (input) => ({ ...input, attemptId: "attempt-missing" }) },
      { label: "session", mutate: (input) => ({ ...input, sessionId: "session-missing" }) },
      { label: "provider", mutate: (input) => ({ ...input, provider: "grok" }) },
      { label: "ordinal", mutate: (input) => ({ ...input, attemptOrdinal: 2 }) },
      { label: "startedAt", mutate: (input) => ({ ...input, startedAt: 999 }) },
      { label: "terminalAt", mutate: (input) => ({ ...input, terminalAt: 1_401 }) },
      { label: "success classification", mutate: (input) => ({ ...input, errorClassification: "provider_error" }) },
      { label: "failure without classification", mutate: (input) => ({
        ...input, outcome: "provider_failure", errorClassification: null,
      }) },
      { label: "timeout classification", mutate: (input) => ({
        ...input, outcome: "timeout", errorClassification: "provider_error",
      }) },
      { label: "malformed classification", mutate: (input) => ({
        ...input, outcome: "malformed_terminal", errorClassification: "timeout",
      }) },
      { label: "exact null", mutate: (input) => ({
        ...input, usageObservation: { status: "exact", usageId: null },
      }) },
      { label: "partial null", mutate: (input) => ({
        ...input, usageObservation: { status: "partial", usageId: null },
      }) },
      { label: "invalid with row", mutate: (input) => ({
        ...input, usageObservation: { status: "invalid_provider_usage", usageId: "usage-a-1" },
      }) },
      { label: "unavailable unknown row", mutate: (input) => ({
        ...input, usageObservation: { status: "unavailable", usageId: "usage-missing" },
      }) },
      { label: "completeness mismatch", mutate: (input) => ({
        ...input, usageObservation: { status: "partial", usageId: "usage-a-1" },
      }) },
      { label: "unknown status", mutate: (input) => ({
        ...input, usageObservation: { status: "unknown", usageId: "usage-a-1" },
      }) },
      { label: "caller event id", mutate: (input) => ({ ...input, eventId: "caller-forged" }) },
    ];
    for (const candidate of invalid) {
      const state = fixture();
      const store = new Store(state.databasePath);
      createRootSession(store, { providerSessionId: "provider-session-a" });
      store.recordUsage(exactUsage());
      if (!candidate.leaveRunning) terminalizeAttempt(state);
      const before = telemetryRows(state.databasePath);
      expect(() => store.recordAttemptTerminal(candidate.mutate(terminalInput())), candidate.label)
        .toThrow(/attempt|terminal|flow|node|session|provider|ordinal|time|outcome|classification|usage|status|identity|field/i);
      expect(telemetryRows(state.databasePath), candidate.label).toEqual(before);
      store.close();
    }
  }, 30_000);

  it("rejects same-flow usage from another attempt/session or provider on a fresh terminal input", async () => {
    const Store = await loadStore();

    const swapped = fixture();
    seedGraphAttempt(swapped.databasePath, {
      attemptId: "attempt-b", flowId: "flow-a", nodeId: "node-b", attemptNo: 1,
      workflowId: "workflow-b", sessionId: "session-b",
    });
    let store = new Store(swapped.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    createRootSession(store, {
      attemptId: "attempt-b", sessionId: "session-b", providerSessionId: "provider-session-b", createdAt: 1_200,
    });
    store.recordUsage(exactUsage({
      nodeId: "node-b", attemptId: "attempt-b", sessionId: "session-b", usageId: "usage-b-1",
      providerSessionId: "provider-session-b", receiptId: "provider-receipt-b-1",
    }));
    const beforeSwap = telemetryRows(swapped.databasePath);
    expect(() => store.recordAttemptTerminal(terminalInput({
      terminalAt: 1_100,
      usageObservation: { status: "exact", usageId: "usage-b-1" },
    }))).toThrow(/usage|attempt|session|identity/i);
    expect(telemetryRows(swapped.databasePath)).toEqual(beforeSwap);
    store.close();

    const providerMismatch = fixture();
    store = new Store(providerMismatch.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.recordUsage(exactUsage({ provider: "grok", usageId: "usage-grok", receiptId: "receipt-grok" }));
    terminalizeAttempt(providerMismatch);
    const beforeProvider = telemetryRows(providerMismatch.databasePath);
    expect(() => store.recordAttemptTerminal(terminalInput({
      usageObservation: { status: "exact", usageId: "usage-grok" },
    }))).toThrow(/usage|provider|identity/i);
    expect(telemetryRows(providerMismatch.databasePath)).toEqual(beforeProvider);
    store.close();
  });

  it("gives concurrent terminal outcomes and a forged caller ID one commit plus deterministic conflicts without a gap", async () => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.close();
    terminalizeAttempt(state, "failed");
    const results = await raceWorkers(state.databasePath, "recordAttemptTerminal", [
      terminalInput({
        outcome: "provider_failure", errorClassification: "provider_error",
        usageObservation: { status: "unavailable", usageId: null },
      }),
      terminalInput({
        outcome: "timeout", errorClassification: "timeout",
        usageObservation: { status: "unavailable", usageId: null },
      }),
      terminalInput({
        eventId: "caller-forged-terminal-id",
        outcome: "provider_failure", errorClassification: "provider_error",
        usageObservation: { status: "unavailable", usageId: null },
      }),
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toHaveLength(2);
    for (const failed of results.filter(({ ok }) => !ok)) {
      expect(failed.error).toMatch(/conflict|immutable|terminal|event.*id|caller|field/i);
    }
    const rows = telemetryRows(state.databasePath);
    expect(rows.agent_events).toHaveLength(1);
    expect(rows.agent_events![0]!.sequence_no).toBe(1);
    expect(rows.agent_events![0]!.event_id).toBe(sha256(canonicalJson({
      flowId: "flow-a", attemptId: "attempt-a", eventVersion: "1",
    })));
    expect(rows.agent_event_payloads).toHaveLength(1);
  });

  it("detects terminal wrapper, every nested identity/outcome/time/usage field, and header tamper on reopen", async () => {
    const Store = await loadStore();
    const cases: Array<{ label: string; sql: string }> = [
      { label: "outer schema", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.schemaVersion','x')` },
      { label: "outer parent", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.parentSessionId','x')` },
      { label: "receipt schema", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.schemaVersion','x')` },
      { label: "flow", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.flowId','x')` },
      { label: "node", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.nodeId','x')` },
      { label: "attempt", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.attemptId','x')` },
      { label: "session", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.sessionId','x')` },
      { label: "provider", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.provider','x')` },
      { label: "ordinal", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.attemptOrdinal',9)` },
      { label: "outcome", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.outcome','timeout')` },
      { label: "classification", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.errorClassification','timeout')` },
      { label: "start", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.startedAt',999)` },
      { label: "terminal", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.terminalAt',999)` },
      { label: "usage", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.usageObservation.status','exact')` },
      { label: "usage identity", sql: `UPDATE agent_event_payloads SET payload_json=json_set(payload_json,'$.data.usageObservation.usageId','x')` },
      { label: "header", sql: `UPDATE agent_events SET span_id='tampered'` },
    ];
    for (const candidate of cases) {
      const state = fixture();
      let store = new Store(state.databasePath);
      createRootSession(store, { providerSessionId: "provider-session-a" });
      terminalizeAttempt(state, "failed");
      store.recordAttemptTerminal(terminalInput({
        outcome: "provider_failure",
        errorClassification: "provider_error",
        usageObservation: { status: "unavailable", usageId: null },
      }));
      store.close();
      const db = new Database(state.databasePath);
      db.pragma("foreign_keys = OFF");
      db.exec(candidate.sql);
      db.close();
      expect(() => { store = new Store(state.databasePath); }, candidate.label)
        .toThrow(/tamper|hash|integrity|receipt|terminal|projection|trace|span|hex/i);
    }
  }, 30_000);

  it.each([
    {
      label: "attempt session binding",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE graph_node_attempts SET session_id='session-detached' WHERE attempt_id='attempt-a'",
      ).run(),
    },
    {
      label: "attempt status",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE graph_node_attempts SET status='cancelled' WHERE attempt_id='attempt-a'",
      ).run(),
    },
    {
      label: "attempt startedAt",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE graph_node_attempts SET created_at=999 WHERE attempt_id='attempt-a'",
      ).run(),
    },
    {
      label: "attempt terminalAt",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE graph_node_attempts SET terminal_at=1401 WHERE attempt_id='attempt-a'",
      ).run(),
    },
    {
      label: "session attempt binding",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_sessions SET attempt_id=NULL WHERE session_id='session-a'",
      ).run(),
    },
    {
      label: "session parent",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_sessions SET parent_session_id='session-detached' WHERE session_id='session-a'",
      ).run(),
    },
    {
      label: "session status",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_sessions SET status='orphaned' WHERE session_id='session-a'",
      ).run(),
    },
    {
      label: "session kind",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_sessions SET kind='coordination' WHERE session_id='session-a'",
      ).run(),
    },
    {
      label: "session startedAt",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_sessions SET created_at=999 WHERE session_id='session-a'",
      ).run(),
    },
    {
      label: "session terminalAt",
      mutate: (db: Database.Database) => db.prepare(
        "UPDATE agent_sessions SET terminal_at=1401 WHERE session_id='session-a'",
      ).run(),
    },
  ])("rejects a row-local-valid $label relational tamper on reopen without further mutation", async ({ mutate }) => {
    const Store = await loadStore();
    const state = fixture();
    let store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    store.createSession({
      sessionId: "session-detached", flowId: "flow-a", attemptId: "attempt-a",
      parentSessionId: null, kind: "coordination", createdAt: 1_001,
    });
    terminalizeAttempt(state, "failed");
    store.recordAttemptTerminal(terminalInput({
      outcome: "provider_failure",
      errorClassification: "provider_error",
      usageObservation: { status: "unavailable", usageId: null },
    }));
    store.close();

    const db = new Database(state.databasePath);
    db.pragma("foreign_keys = ON");
    try { mutate(db); }
    finally { db.close(); }
    const tamperedRows = telemetryRows(state.databasePath);
    const tamperedBytes = readFileSync(state.databasePath);
    expect(() => {
      store = new Store(state.databasePath);
      store.close();
    }).toThrow(/terminal|session|attempt|ancestry|provider|identity|relational|integrity/i);
    expect(telemetryRows(state.databasePath)).toEqual(tamperedRows);
    expect(readFileSync(state.databasePath).equals(tamperedBytes)).toBe(true);
  });

  it("uses distinct deterministic receipts for retry attempts and never mutates graph execution rows", async () => {
    const Store = await loadStore();
    const state = fixture();
    seedGraphAttempt(state.databasePath, {
      attemptId: "attempt-a-retry",
      flowId: "flow-a",
      nodeId: "node-a",
      attemptNo: 2,
      workflowId: "workflow-a-retry",
      sessionId: "session-a-retry",
      createdAt: 2_000,
    });
    const store = new Store(state.databasePath);
    createRootSession(store, { providerSessionId: "provider-session-a" });
    createRootSession(store, {
      attemptId: "attempt-a-retry", sessionId: "session-a-retry",
      providerSessionId: "provider-session-a-retry", createdAt: 2_000,
    });
    terminalizeAttempt(state, "failed", {
      attemptId: "attempt-a-retry", terminalAt: 2_400,
    });
    const graphBefore = graphExecutionRows(telemetryRows(state.databasePath));
    const first = store.recordAttemptTerminal(terminalInput({
      outcome: "provider_failure", errorClassification: "provider_error",
      usageObservation: { status: "unavailable", usageId: null },
    }));
    const retry = store.recordAttemptTerminal(terminalInput({
      attemptId: "attempt-a-retry",
      sessionId: "session-a-retry",
      attemptOrdinal: 2,
      outcome: "provider_failure",
      errorClassification: "provider_error",
      startedAt: 2_000,
      terminalAt: 2_400,
      usageObservation: { status: "unavailable", usageId: null },
    }));
    expect(first.eventId).not.toBe(retry.eventId);
    expect(graphExecutionRows(telemetryRows(state.databasePath))).toEqual(graphBefore);
    store.close();
  });

  it("returns an unlinked legacy projection with zero graph or telemetry effects", async () => {
    const Store = await loadStore();
    const state = fixture();
    const runStore = new RunStore(state.databasePath);
    const queued = runStore.enqueue({
      idempotencyKey: "legacy-key", stage: "planning", priority: 1, now: 1_000,
    });
    const claimed = runStore.claimNext({ workerId: "legacy-worker", leaseMs: 1_000, now: 1_001 });
    expect(claimed?.id).toBe(queued.id);
    runStore.complete(claimed!.id, claimed!.leaseToken!, { complete: true });
    runStore.close();
    const store = new Store(state.databasePath);
    const before = telemetryRows(state.databasePath);
    expect(before.runs!.find(({ id }) => id === queued.id)).toEqual(expect.objectContaining({
      status: "completed",
    }));
    expect(store.getRunTelemetryLink(queued.id)).toEqual({
      status: "legacy_unlinked",
      usage: null,
      completeness: "unavailable",
    });
    expect(telemetryRows(state.databasePath)).toEqual(before);
    store.close();
  });
});
