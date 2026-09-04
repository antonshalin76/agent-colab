import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import canonicalize from "canonicalize";
import { afterEach, describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

interface AgentEventEnvelope extends JsonObject {
  schemaVersion: "FlowEvent/v1";
  eventId: string;
  flowId: string;
  sequenceNo: number;
  nodeId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  eventType: string;
  eventVersion: string;
  payloadSha256: string;
  previousEventSha256: string | null;
  parentSessionId: string | null;
  traceId: string | null;
  spanId: string | null;
  createdAt: number;
  eventSha256: string;
}

interface NormalizedUsage extends JsonObject {
  status: "exact" | "partial" | "unavailable" | "invalid_provider_usage";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costMicroUsd: number | null;
  provenance: Record<string, string>;
}

interface UsageAggregationRecord extends JsonObject {
  usageId: string;
  attemptId: string;
  provider: string;
  providerSessionId: string;
  receiptId: string;
  scope: "self" | "subtree";
  coveredAttemptIds: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  completeness: "exact" | "partial" | "unavailable";
}

interface TelemetryPureRuntime {
  assertTelemetryIdentitySafe(value: unknown, label: string): string;
  createAgentEventEnvelope(input: JsonObject): {
    readonly event: AgentEventEnvelope;
    readonly payloadJson: string;
  };
  verifyAgentEventEnvelope(
    event: AgentEventEnvelope,
    payloadJson: string,
    previous?: AgentEventEnvelope,
  ): void;
  normalizeProviderUsage(input: { provider: string; usage: unknown }): NormalizedUsage;
  aggregateUsage(input: readonly UsageAggregationRecord[], context: { attemptIds: readonly string[] }): {
    inputTokens: number | null;
    outputTokens: number | null;
    costMicroUsd: number | null;
    completeness: "exact" | "partial" | "unavailable";
    selectedUsageIds: readonly string[];
    skippedOverlapUsageIds: readonly string[];
    uncoveredAttemptIds: readonly string[];
  };
  deriveAttemptTerminalEventId(input: { flowId: string; attemptId: string; eventVersion: string }): string;
  deriveUsageCoverageSha256(coveredAttemptIds: readonly string[]): string;
}

interface ExportRuntime {
  dispatchTelemetryExport(input: {
    exporter: (payload: Readonly<JsonObject>) => unknown | Promise<unknown>;
    payload: Readonly<JsonObject>;
    timeoutMs: number;
  }): {
    dispatched: true;
    delivery: "best_effort_duplicate_or_loss_possible";
  };
}

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("test value is not canonicalizable");
  return encoded;
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function loadPureRuntime(): Promise<TelemetryPureRuntime> {
  return await import(pathToFileURL(resolve("src/runtime/flow-telemetry.ts")).href) as unknown as TelemetryPureRuntime;
}

async function loadExportRuntime(): Promise<ExportRuntime> {
  return await import(pathToFileURL(resolve("src/runtime/flow-telemetry-exporter.ts")).href) as unknown as ExportRuntime;
}

function payloadWithExactUtf8Bytes(bytes: number): JsonObject {
  const base = { schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data: { text: "" } };
  const remaining = bytes - Buffer.byteLength(canonicalJson(base));
  if (remaining < 0) throw new Error("requested payload is smaller than its wrapper");
  return {
    ...base,
    data: { text: `${"€".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}` },
  };
}

function eventInput(overrides: JsonObject = {}): JsonObject {
  return {
    eventId: "event-0001",
    flowId: "flow-a",
    sequenceNo: 1,
    nodeId: "node-a",
    attemptId: "attempt-a",
    sessionId: "session-a",
    eventType: "attempt_started",
    eventVersion: "1",
    payload: {
      schemaVersion: "TelemetryPayload/v1",
      parentSessionId: null,
      data: { safe: true },
    },
    previousEventSha256: null,
    parentSessionId: null,
    traceId: null,
    spanId: null,
    createdAt: 1_780_000_000_000,
    ...overrides,
  };
}

const aggregationRecord = (
  usageId: string,
  attemptId: string,
  amount: number,
  scope: "self" | "subtree",
  coveredAttemptIds: string[] = [],
): UsageAggregationRecord => ({
  usageId,
  attemptId,
  provider: "codex",
  providerSessionId: `provider-${attemptId}`,
  receiptId: `receipt-${usageId}`,
  scope,
  coveredAttemptIds,
  inputTokens: amount,
  outputTokens: amount,
  costMicroUsd: amount,
  completeness: "exact",
});

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((tail) => [value, ...tail]));
}

describe("flow telemetry event and payload contract", () => {
  const stableIdFields = [
    "flowId", "nodeId", "attemptId", "parentSessionId", "usageId", "receiptId", "requestId",
  ] as const;

  it.each(stableIdFields)("accepts 127-byte and 128-byte ASCII boundaries for %s", async (field) => {
    const runtime = await loadPureRuntime();
    for (const value of ["i".repeat(127), "i".repeat(128)]) {
      expect(runtime.assertTelemetryIdentitySafe(value, field)).toBe(value);
    }
  });

  it.each(stableIdFields.flatMap((field) => ([
    [field, "empty", ""],
    [field, "overlong", "i".repeat(129)],
    [field, "control", "identity\nforged"],
    [field, "sensitive", "ghp_abcdefghijklmno"],
  ] as const)))("rejects %s %s identity policy case", async (field, _case, value) => {
    const runtime = await loadPureRuntime();
    expect(() => runtime.assertTelemetryIdentitySafe(value, field)).toThrow(
      new RegExp(`${field}.*(identity|ascii|length|bounded|control|sensitive|non.?empty|safe|invalid)`, "i"),
    );
  });

  it("hashes the exact caller identity and every nullable header field on a one-based chain", async () => {
    const runtime = await loadPureRuntime();
    const first = runtime.createAgentEventEnvelope(eventInput());
    expect(first.payloadJson).toBe(canonicalJson(eventInput().payload));
    expect(first.event).toMatchObject({
      schemaVersion: "FlowEvent/v1",
      eventId: "event-0001",
      flowId: "flow-a",
      sequenceNo: 1,
      previousEventSha256: null,
      parentSessionId: null,
    });
    const { eventSha256, ...unsigned } = first.event;
    expect(Object.keys(unsigned).sort()).toEqual([
      "attemptId", "createdAt", "eventId", "eventType", "eventVersion", "flowId", "nodeId",
      "parentSessionId", "payloadSha256", "previousEventSha256", "schemaVersion", "sequenceNo",
      "sessionId", "spanId", "traceId",
    ].sort());
    expect(first.event.payloadSha256).toBe(sha256(first.payloadJson));
    expect(eventSha256).toBe(sha256(canonicalJson(unsigned)));
    expect(() => runtime.verifyAgentEventEnvelope(first.event, first.payloadJson)).not.toThrow();

    const second = runtime.createAgentEventEnvelope(eventInput({
      eventId: "event-0002",
      sequenceNo: 2,
      previousEventSha256: first.event.eventSha256,
      sessionId: "session-child",
      parentSessionId: "session-a",
      payload: {
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: "session-a",
        data: { safe: "child" },
      },
      createdAt: 1_780_000_000_001,
    }));
    expect(() => runtime.verifyAgentEventEnvelope(second.event, second.payloadJson, first.event)).not.toThrow();
    expect(() => runtime.verifyAgentEventEnvelope(
      { ...second.event, previousEventSha256: "0".repeat(64) }, second.payloadJson, first.event,
    )).toThrow(/chain|previous|hash/i);
    expect(() => runtime.createAgentEventEnvelope(eventInput({ sequenceNo: 0 }))).toThrow(/one-based|sequence/i);
    expect(() => runtime.createAgentEventEnvelope(eventInput({ sequenceNo: 2, previousEventSha256: null })))
      .toThrow(/previous|sequence|chain/i);
  });

  it("detects independent mutation of every envelope field, event hash, payload, and parent copy", async () => {
    const runtime = await loadPureRuntime();
    const { event, payloadJson } = runtime.createAgentEventEnvelope(eventInput());
    const mutations: Partial<Record<keyof AgentEventEnvelope, unknown>> = {
      schemaVersion: "FlowEvent/v2",
      eventId: "event-other",
      flowId: "flow-other",
      sequenceNo: 2,
      nodeId: "node-other",
      attemptId: "attempt-other",
      sessionId: "session-other",
      eventType: "other",
      eventVersion: "2",
      payloadSha256: "0".repeat(64),
      previousEventSha256: "1".repeat(64),
      parentSessionId: "parent-other",
      traceId: "trace-other",
      spanId: "span-other",
      createdAt: event.createdAt + 1,
      eventSha256: "f".repeat(64),
    };
    for (const [field, changed] of Object.entries(mutations)) {
      expect(() => runtime.verifyAgentEventEnvelope({ ...event, [field]: changed }, payloadJson), field)
        .toThrow(/event|hash|payload|parent|sequence|chain|trace|span|hex/i);
    }
    expect(() => runtime.verifyAgentEventEnvelope(event, canonicalJson({ changed: true })))
      .toThrow(/payload|hash|wrapper/i);
    expect(() => runtime.createAgentEventEnvelope(eventInput({
      parentSessionId: "session-parent",
      payload: { schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data: { safe: true } },
    }))).toThrow(/parent/i);
  });

  it("accepts exactly 4096 multibyte UTF-8 bytes and rejects overflow or forbidden nested semantics", async () => {
    const runtime = await loadPureRuntime();
    const exact = payloadWithExactUtf8Bytes(4_096);
    expect(Buffer.byteLength(canonicalJson(exact), "utf8")).toBe(4_096);
    expect(() => runtime.createAgentEventEnvelope(eventInput({ payload: exact }))).not.toThrow();
    expect(() => runtime.createAgentEventEnvelope(eventInput({ payload: payloadWithExactUtf8Bytes(4_097) })))
      .toThrow(/4096|4 KiB|payload/i);
    for (const data of [
      { nested: { reasoning: "raw chain of thought" } },
      { nested: { chainOfThought: "private" } },
      { nested: { toolArguments: { path: "/private" } } },
      { nested: { toolResult: "raw result" } },
      { nested: { credential: "secret" } },
      { nested: { authorization: "Bearer secret" } },
    ]) {
      expect(() => runtime.createAgentEventEnvelope(eventInput({
        payload: { schemaVersion: "TelemetryPayload/v1", parentSessionId: null, data },
      }))).toThrow(/forbidden|reasoning|tool|credential|authorization|payload/i);
    }

    const redacted = runtime.createAgentEventEnvelope(eventInput({
      payload: {
        schemaVersion: "TelemetryPayload/v1",
        parentSessionId: null,
        data: {
          message: "Authorization: Bearer TELEMETRY_DUMMY_TOKEN",
          metadata: { accessToken: "opaque-dummy-value", safe: "kept" },
        },
      },
    }));
    expect(JSON.parse(redacted.payloadJson)).toEqual({
      schemaVersion: "TelemetryPayload/v1",
      parentSessionId: null,
      data: {
        message: "Authorization: Bearer [REDACTED]",
        metadata: { accessToken: "[REDACTED]", safe: "kept" },
      },
    });
    expect(redacted.payloadJson).not.toContain("TELEMETRY_DUMMY_TOKEN");
    expect(redacted.payloadJson).not.toContain("opaque-dummy-value");
    expect(redacted.event.payloadSha256).toBe(sha256(redacted.payloadJson));
  });
});

describe("provider usage normalization", () => {
  it("preserves six reported fields, losslessly derives micro-USD, and uses exact provenance keys", async () => {
    const runtime = await loadPureRuntime();
    const normalized = runtime.normalizeProviderUsage({
      provider: "codex",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningTokens: 1,
        totalTokens: 15,
        costUsd: 0.0042,
      },
    });
    expect(Object.keys(normalized).sort()).toEqual([
      "cachedInputTokens", "costMicroUsd", "costUsd", "inputTokens", "outputTokens",
      "provenance", "reasoningTokens", "status", "totalTokens",
    ].sort());
    expect(Object.keys(normalized.provenance).sort()).toEqual([
      "cachedInputTokens", "costMicroUsd", "costUsd", "inputTokens", "outputTokens",
      "reasoningTokens", "totalTokens",
    ].sort());
    expect(normalized).toEqual({
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
    });
  });

  it("classifies completeness from only the three accounting fields and never invents unknown values", async () => {
    const runtime = await loadPureRuntime();
    expect(runtime.normalizeProviderUsage({
      provider: "grok",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0000005 },
    })).toEqual({
      status: "partial",
      inputTokens: 10,
      cachedInputTokens: null,
      outputTokens: 5,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: 0.0000005,
      costMicroUsd: null,
      provenance: {
        inputTokens: "provider_reported",
        cachedInputTokens: "unavailable",
        outputTokens: "provider_reported",
        reasoningTokens: "unavailable",
        totalTokens: "unavailable",
        costUsd: "provider_reported",
        costMicroUsd: "unavailable_fractional_microusd",
      },
    });
    expect(runtime.normalizeProviderUsage({
      provider: "codex",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    })).toEqual({
      status: "exact",
      inputTokens: 0,
      cachedInputTokens: null,
      outputTokens: 0,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: 0,
      costMicroUsd: 0,
      provenance: {
        inputTokens: "provider_reported",
        cachedInputTokens: "unavailable",
        outputTokens: "provider_reported",
        reasoningTokens: "unavailable",
        totalTokens: "unavailable",
        costUsd: "provider_reported",
        costMicroUsd: "lossless_usd_to_microusd",
      },
    });
    expect(runtime.normalizeProviderUsage({ provider: "claude", usage: { totalTokens: 7 } }))
      .toEqual({
        status: "unavailable",
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: 7,
        costUsd: null,
        costMicroUsd: null,
        provenance: {
          inputTokens: "unavailable",
          cachedInputTokens: "unavailable",
          outputTokens: "unavailable",
          reasoningTokens: "unavailable",
          totalTokens: "provider_reported",
          costUsd: "unavailable",
          costMicroUsd: "unavailable",
        },
      });
    expect(runtime.normalizeProviderUsage({ provider: "claude", usage: null })).toEqual({
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
    });
  });

  it.each([
    ["inputTokens", -1], ["inputTokens", 1.5], ["inputTokens", Number.NaN],
    ["inputTokens", Number.POSITIVE_INFINITY], ["inputTokens", Number.MAX_SAFE_INTEGER + 1],
    ["cachedInputTokens", -1], ["outputTokens", 1.5], ["reasoningTokens", Number.NaN],
    ["totalTokens", Number.MAX_SAFE_INTEGER + 1], ["costUsd", -0.1],
    ["costUsd", Number.NaN], ["costUsd", Number.POSITIVE_INFINITY],
    ["costUsd", Number.MAX_SAFE_INTEGER],
  ] as const)("rejects unsafe provider field %s=%s as one invalid observation", async (field, value) => {
    const runtime = await loadPureRuntime();
    expect(runtime.normalizeProviderUsage({
      provider: "codex",
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.000001, [field]: value },
    })).toEqual({
      status: "invalid_provider_usage",
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
    });
  });
});

describe("deterministic usage aggregation", () => {
  it("returns the hand-calculated 42 partial result for all 720 insertion orders", async () => {
    const runtime = await loadPureRuntime();
    const records = [
      aggregationRecord("usage-x", "X", 5, "self"),
      aggregationRecord("usage-b-self", "B", 1_000, "self"),
      aggregationRecord("usage-a", "A", 30, "subtree", ["B", "C"]),
      aggregationRecord("usage-b", "B", 20, "subtree", ["C"]),
      aggregationRecord("usage-d", "D", 7, "subtree", ["E"]),
      aggregationRecord("usage-c", "C", 11, "subtree", ["F"]),
    ];
    const orders = permutations(records);
    expect(orders).toHaveLength(720);
    for (const ordered of orders) {
      expect(runtime.aggregateUsage(ordered, { attemptIds: ["A", "B", "C", "D", "E", "F", "X"] }))
        .toEqual({
          inputTokens: 42,
          outputTokens: 42,
          costMicroUsd: 42,
          completeness: "partial",
          selectedUsageIds: ["usage-a", "usage-d", "usage-x"],
          skippedOverlapUsageIds: ["usage-c"],
          uncoveredAttemptIds: ["F"],
        });
    }
  });

  it("uses lexical ties, counts retries, deduplicates exact identity, and rejects conflicts or overflow", async () => {
    const runtime = await loadPureRuntime();
    const tieA = aggregationRecord("usage-a", "A", 7, "subtree", ["C"]);
    const tieZ = aggregationRecord("usage-z", "B", 11, "subtree", ["C"]);
    for (const ordered of permutations([tieZ, tieA])) {
      expect(runtime.aggregateUsage(ordered, { attemptIds: ["A", "B", "C"] })).toEqual({
        inputTokens: 7,
        outputTokens: 7,
        costMicroUsd: 7,
        completeness: "partial",
        selectedUsageIds: ["usage-a"],
        skippedOverlapUsageIds: ["usage-z"],
        uncoveredAttemptIds: ["B"],
      });
    }

    const retryOne = aggregationRecord("retry-1", "attempt-1", 3, "self");
    const retryTwo = aggregationRecord("retry-2", "attempt-2", 5, "self");
    expect(runtime.aggregateUsage([retryOne, retryTwo, structuredClone(retryOne)], {
      attemptIds: ["attempt-1", "attempt-2"],
    })).toEqual({
      inputTokens: 8,
      outputTokens: 8,
      costMicroUsd: 8,
      completeness: "exact",
      selectedUsageIds: ["retry-1", "retry-2"],
      skippedOverlapUsageIds: [],
      uncoveredAttemptIds: [],
    });
    expect(() => runtime.aggregateUsage([
      retryOne,
      { ...retryOne, inputTokens: 4 },
    ], { attemptIds: ["attempt-1"] })).toThrow(/duplicate|identity|conflict/i);
    expect(() => runtime.aggregateUsage([
      retryOne,
      { ...retryOne, usageId: "retry-1-alias" },
    ], { attemptIds: ["attempt-1"] })).toThrow(/natural|receipt|identity|duplicate|conflict/i);
    expect(() => runtime.aggregateUsage([
      aggregationRecord("large-a", "A", Number.MAX_SAFE_INTEGER, "self"),
      aggregationRecord("large-b", "B", 1, "self"),
    ], { attemptIds: ["A", "B"] })).toThrow(/overflow|safe integer|aggregate/i);
  });

  it("keeps unknown nullable and binds sorted unique subtree coverage", async () => {
    const runtime = await loadPureRuntime();
    const unavailable: UsageAggregationRecord = {
      ...aggregationRecord("unknown", "A", 0, "self"),
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      completeness: "unavailable",
    };
    expect(runtime.aggregateUsage([unavailable], { attemptIds: ["A", "B"] })).toEqual({
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      completeness: "unavailable",
      selectedUsageIds: ["unknown"],
      skippedOverlapUsageIds: [],
      uncoveredAttemptIds: ["B"],
    });
    const mixed: UsageAggregationRecord = {
      ...aggregationRecord("mixed", "A", 2, "self"),
      outputTokens: null,
      costMicroUsd: null,
      completeness: "partial",
    };
    expect(runtime.aggregateUsage([mixed], { attemptIds: ["A"] })).toEqual({
      inputTokens: 2,
      outputTokens: null,
      costMicroUsd: null,
      completeness: "partial",
      selectedUsageIds: ["mixed"],
      skippedOverlapUsageIds: [],
      uncoveredAttemptIds: [],
    });
    const expected = sha256(canonicalJson(["attempt-b", "attempt-c"]));
    expect(runtime.deriveUsageCoverageSha256(["attempt-b", "attempt-c"])).toBe(expected);
    expect(() => runtime.deriveUsageCoverageSha256(["attempt-c", "attempt-b"]))
      .toThrow(/sorted|coverage/i);
    expect(() => runtime.deriveUsageCoverageSha256(["attempt-b", "attempt-b"]))
      .toThrow(/unique|duplicate|coverage/i);
  });

  it("derives one stable terminal identity only from flow, attempt, and event version", async () => {
    const runtime = await loadPureRuntime();
    const identity = { flowId: "flow-a", attemptId: "attempt-a", eventVersion: "1" };
    const eventId = runtime.deriveAttemptTerminalEventId(identity);
    expect(eventId).toBe(sha256(canonicalJson(identity)));
    expect(eventId).toBe(runtime.deriveAttemptTerminalEventId(identity));
    expect(eventId).not.toBe(runtime.deriveAttemptTerminalEventId({ ...identity, attemptId: "attempt-b" }));
    expect(eventId).not.toBe(runtime.deriveAttemptTerminalEventId({ ...identity, eventVersion: "2" }));
  });
});

describe("bounded detached telemetry exporter", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  it("starts only after return and bounds sync throw, async reject, and never-settling export", async () => {
    const runtime = await loadExportRuntime();
    process.on("unhandledRejection", onUnhandled);
    const payload = Object.freeze({ schemaVersion: "TelemetryExport/v1", safe: true });
    let callerReturned = false;
    const invocationStates: boolean[] = [];
    const exporters = [
      () => { invocationStates.push(callerReturned); throw new Error("sync export failure"); },
      async () => { invocationStates.push(callerReturned); throw new Error("async export failure"); },
      () => { invocationStates.push(callerReturned); return new Promise(() => undefined); },
    ];
    const start = performance.now();
    for (const exporter of exporters) {
      expect(runtime.dispatchTelemetryExport({ exporter, payload, timeoutMs: 20 })).toEqual({
        dispatched: true,
        delivery: "best_effort_duplicate_or_loss_possible",
      });
    }
    callerReturned = true;
    expect(performance.now() - start).toBeLessThan(50);
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    expect(invocationStates).toEqual([true, true, true]);
    expect(unhandled).toEqual([]);
    expect(payload).toEqual({ schemaVersion: "TelemetryExport/v1", safe: true });
  });

  it("rejects unsafe or unbounded export data before scheduling any side effect", async () => {
    const runtime = await loadExportRuntime();
    let calls = 0;
    const exporter = (): void => { calls += 1; };
    expect(() => runtime.dispatchTelemetryExport({
      exporter,
      payload: { schemaVersion: "TelemetryExport/v1", toolArguments: { token: "secret" } },
      timeoutMs: 20,
    })).toThrow(/redact|forbidden|tool|credential/i);
    expect(() => runtime.dispatchTelemetryExport({
      exporter,
      payload: { schemaVersion: "TelemetryExport/v1", safe: "€".repeat(2_000) },
      timeoutMs: 20,
    })).toThrow(/4096|4 KiB|bounded|payload/i);
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(calls).toBe(0);
  });

  it("applies generic redaction before the detached exporter receives otherwise allowed strings", async () => {
    const runtime = await loadExportRuntime();
    const observed: Readonly<JsonObject>[] = [];
    const input = Object.freeze({
      schemaVersion: "TelemetryExport/v1",
      message: "Authorization: Bearer EXPORT_DUMMY_TOKEN",
      metadata: { accessToken: "opaque-export-dummy", safe: "kept" },
    });
    expect(runtime.dispatchTelemetryExport({
      exporter: (payload) => { observed.push(payload); },
      payload: input,
      timeoutMs: 20,
    })).toEqual({ dispatched: true, delivery: "best_effort_duplicate_or_loss_possible" });
    expect(observed).toEqual([]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(observed).toEqual([{
      schemaVersion: "TelemetryExport/v1",
      message: "Authorization: Bearer [REDACTED]",
      metadata: { accessToken: "[REDACTED]", safe: "kept" },
    }]);
    expect(JSON.stringify(observed)).not.toContain("EXPORT_DUMMY_TOKEN");
    expect(JSON.stringify(observed)).not.toContain("opaque-export-dummy");
    expect(input).toEqual({
      schemaVersion: "TelemetryExport/v1",
      message: "Authorization: Bearer EXPORT_DUMMY_TOKEN",
      metadata: { accessToken: "opaque-export-dummy", safe: "kept" },
    });
  });
});

describe("telemetry package boundary", () => {
  it("does not own @opentelemetry/api as a direct package or lock-root dependency", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")) as {
      packages?: Record<string, { dependencies?: Record<string, string> }>;
    };
    expect(packageJson.dependencies).not.toHaveProperty("@opentelemetry/api");
    expect(packageLock.packages?.[""]?.dependencies).not.toHaveProperty("@opentelemetry/api");
    expect(packageLock.packages).not.toHaveProperty("node_modules/@opentelemetry/api");
  });
});
