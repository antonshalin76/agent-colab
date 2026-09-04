import { randomUUID } from "node:crypto";
import {
  assertJsonDocument,
  canonicalJson,
  computeBytesSha256,
} from "../domain/canonical-json.js";
import { sanitizeResult } from "../security/redaction.js";
import {
  assertNullableTelemetryStableId,
  assertProviderSessionIdentity,
  assertTelemetryEventType,
  assertTelemetryEventVersion,
  assertTelemetryIdentitySafe,
  assertTelemetryProvider,
  assertTelemetrySpanId,
  assertTelemetryStableId,
  assertTelemetryTraceId,
} from "./flow-telemetry-identity.js";

export { assertTelemetryIdentitySafe } from "./flow-telemetry-identity.js";

export const USAGE_COMPLETENESS = ["exact", "partial", "unavailable"] as const;
export type UsageCompleteness = (typeof USAGE_COMPLETENESS)[number];
export type NormalizedUsageStatus = UsageCompleteness | "invalid_provider_usage";
export type UsageProvenance = "provider_reported" | "derived" | "unavailable";
export type NormalizedUsageProvenance =
  | "provider_reported"
  | "unavailable"
  | "lossless_usd_to_microusd"
  | "unavailable_fractional_microusd";

export const PROVIDER_USAGE_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
] as const;
export type ProviderUsageField = (typeof PROVIDER_USAGE_FIELDS)[number];
export type NormalizedUsageField = ProviderUsageField | "costMicroUsd";

export interface UsageTelemetry {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly provenance: Readonly<Record<ProviderUsageField, UsageProvenance>>;
}

export interface NormalizedProviderUsage {
  readonly status: NormalizedUsageStatus;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly costMicroUsd: number | null;
  readonly provenance: Readonly<Record<NormalizedUsageField, NormalizedUsageProvenance>>;
}

/** Compatibility receipt used by the pre-v4 in-memory graph helpers. */
export interface UsageReceipt {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costMicroUsd?: number | null;
  readonly completeness: UsageCompleteness;
  readonly scope?: "self" | "subtree";
  readonly attemptId?: string;
  readonly coveredAttemptIds?: readonly string[];
  readonly receiptId?: string;
  readonly provider?: string;
  readonly providerSessionId?: string;
}

export interface UsageAggregationRecord {
  readonly usageId: string;
  readonly attemptId: string;
  readonly provider: string;
  readonly providerSessionId: string;
  readonly receiptId: string;
  readonly scope: "self" | "subtree";
  readonly coveredAttemptIds: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicroUsd: number | null;
  readonly completeness: UsageCompleteness;
}

export interface AggregatedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicroUsd: number | null;
  readonly completeness: UsageCompleteness;
}

export interface DeterministicAggregatedUsage extends AggregatedUsage {
  readonly selectedUsageIds: readonly string[];
  readonly skippedOverlapUsageIds: readonly string[];
  readonly uncoveredAttemptIds: readonly string[];
}

export interface FlowEventInput {
  readonly flowId: string;
  readonly sequenceNo: number;
  readonly eventType: string;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly nodeId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
}

export interface FlowEvent extends FlowEventInput {
  readonly schemaVersion: "FlowEvent/v1";
  readonly eventId: string;
  readonly previousEventHash: string | null;
  readonly payloadHash: string;
  readonly eventHash: string;
}

export interface TelemetryPayload {
  readonly schemaVersion: "TelemetryPayload/v1";
  readonly parentSessionId: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AgentEventInput {
  readonly eventId: string;
  readonly flowId: string;
  readonly sequenceNo: number;
  readonly nodeId: string | null;
  readonly attemptId: string | null;
  readonly sessionId: string | null;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly payload: TelemetryPayload;
  readonly previousEventSha256: string | null;
  readonly parentSessionId: string | null;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly createdAt: number;
}

export interface AgentEventEnvelope extends Omit<AgentEventInput, "payload"> {
  readonly schemaVersion: "FlowEvent/v1";
  readonly payloadSha256: string;
  readonly eventSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TELEMETRY_PAYLOAD_BYTES = 4_096;
const EVENT_INPUT_KEYS = new Set([
  "eventId", "flowId", "sequenceNo", "nodeId", "attemptId", "sessionId", "eventType",
  "eventVersion", "payload", "previousEventSha256", "parentSessionId", "traceId", "spanId",
  "createdAt",
]);
const EVENT_ENVELOPE_KEYS = new Set([
  "schemaVersion", "eventId", "flowId", "sequenceNo", "nodeId", "attemptId", "sessionId",
  "eventType", "eventVersion", "payloadSha256", "previousEventSha256", "parentSessionId",
  "traceId", "spanId", "createdAt", "eventSha256",
]);
const PAYLOAD_KEYS = new Set(["schemaVersion", "parentSessionId", "data"]);
const FORBIDDEN_TELEMETRY_KEYS = new Set([
  "reasoning", "rawreasoning", "chainofthought", "toolargument", "toolarguments",
  "toolresult", "toolresults", "credential", "credentials", "authorization", "prompt",
  "stdout", "stderr", "rawoutput",
]);

export const isUsageCompleteness = (value: unknown): value is UsageCompleteness =>
  typeof value === "string" && (USAGE_COMPLETENESS as readonly string[]).includes(value);

export function normalizeProviderUsage(input: {
  readonly provider: string;
  readonly usage: unknown;
}): NormalizedProviderUsage {
  assertTelemetryProvider(input.provider, "provider");
  if (input.usage === null || input.usage === undefined) return unavailableProviderUsage("unavailable");
  const usage = plainRecord(input.usage);
  if (usage === null) return unavailableProviderUsage("invalid_provider_usage");

  const tokenValues = {
    inputTokens: nullableProviderNumber(usage, "inputTokens"),
    cachedInputTokens: nullableProviderNumber(usage, "cachedInputTokens"),
    outputTokens: nullableProviderNumber(usage, "outputTokens"),
    reasoningTokens: nullableProviderNumber(usage, "reasoningTokens"),
    totalTokens: nullableProviderNumber(usage, "totalTokens"),
  };
  if (Object.values(tokenValues).some((field) => field.invalid)) {
    return unavailableProviderUsage("invalid_provider_usage");
  }

  const cost = nullableProviderNumber(usage, "costUsd");
  if (cost.invalid || (cost.value !== null && cost.value < 0)) {
    return unavailableProviderUsage("invalid_provider_usage");
  }
  for (const field of Object.values(tokenValues)) {
    if (field.value !== null && (!Number.isSafeInteger(field.value) || field.value < 0)) {
      return unavailableProviderUsage("invalid_provider_usage");
    }
  }

  let costMicroUsd: number | null = null;
  let costMicroUsdProvenance: NormalizedUsageProvenance = "unavailable";
  if (cost.value !== null) {
    const converted = cost.value * 1_000_000;
    if (!Number.isFinite(converted) || Math.abs(converted) > Number.MAX_SAFE_INTEGER) {
      return unavailableProviderUsage("invalid_provider_usage");
    }
    if (Number.isSafeInteger(converted)) {
      costMicroUsd = converted;
      costMicroUsdProvenance = "lossless_usd_to_microusd";
    } else {
      costMicroUsdProvenance = "unavailable_fractional_microusd";
    }
  }

  const canonicalKnown = [tokenValues.inputTokens.value, tokenValues.outputTokens.value, costMicroUsd]
    .filter((value) => value !== null).length;
  const status: UsageCompleteness = canonicalKnown === 3
    ? "exact"
    : canonicalKnown === 0
      ? "unavailable"
      : "partial";
  return deepFreeze({
    status,
    inputTokens: tokenValues.inputTokens.value,
    cachedInputTokens: tokenValues.cachedInputTokens.value,
    outputTokens: tokenValues.outputTokens.value,
    reasoningTokens: tokenValues.reasoningTokens.value,
    totalTokens: tokenValues.totalTokens.value,
    costUsd: cost.value,
    costMicroUsd,
    provenance: {
      inputTokens: tokenValues.inputTokens.value === null ? "unavailable" : "provider_reported",
      cachedInputTokens: tokenValues.cachedInputTokens.value === null ? "unavailable" : "provider_reported",
      outputTokens: tokenValues.outputTokens.value === null ? "unavailable" : "provider_reported",
      reasoningTokens: tokenValues.reasoningTokens.value === null ? "unavailable" : "provider_reported",
      totalTokens: tokenValues.totalTokens.value === null ? "unavailable" : "provider_reported",
      costUsd: cost.value === null ? "unavailable" : "provider_reported",
      costMicroUsd: costMicroUsdProvenance,
    },
  });
}

export function aggregateUsage(input: readonly UsageReceipt[]): AggregatedUsage;
export function aggregateUsage(
  input: readonly UsageAggregationRecord[],
  context: { readonly attemptIds: readonly string[] },
): DeterministicAggregatedUsage;
export function aggregateUsage(
  input: readonly UsageReceipt[] | readonly UsageAggregationRecord[],
  context?: { readonly attemptIds: readonly string[] },
): AggregatedUsage | DeterministicAggregatedUsage {
  return context === undefined
    ? aggregateLegacyUsage(input as readonly UsageReceipt[])
    : aggregateDeterministicUsage(input as readonly UsageAggregationRecord[], context.attemptIds);
}

export function createAgentEventEnvelope(input: AgentEventInput): {
  readonly event: AgentEventEnvelope;
  readonly payloadJson: string;
} {
  assertExactKeys(input, EVENT_INPUT_KEYS, "agent event input");
  validateEventHeader(input);
  const payload = sanitizeTelemetryProjection(input.payload, true) as unknown as TelemetryPayload;
  if (payload.parentSessionId !== input.parentSessionId) {
    throw new Error("telemetry payload parent does not match event parent");
  }
  const payloadJson = canonicalJson(payload);
  const unsigned = {
    schemaVersion: "FlowEvent/v1" as const,
    eventId: input.eventId,
    flowId: input.flowId,
    sequenceNo: input.sequenceNo,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    payloadSha256: computeBytesSha256(payloadJson),
    previousEventSha256: input.previousEventSha256,
    parentSessionId: input.parentSessionId,
    traceId: input.traceId,
    spanId: input.spanId,
    createdAt: input.createdAt,
  };
  const event = deepFreeze({
    ...unsigned,
    eventSha256: computeBytesSha256(canonicalJson(unsigned)),
  });
  return deepFreeze({ event, payloadJson });
}

export function verifyAgentEventEnvelope(
  event: AgentEventEnvelope,
  payloadJson: string,
  previous?: AgentEventEnvelope,
): void {
  assertExactKeys(event, EVENT_ENVELOPE_KEYS, "agent event envelope");
  const payload = parseCanonicalTelemetryPayload(payloadJson);
  validateEventHeader({ ...event, payload });
  if (payload.parentSessionId !== event.parentSessionId) {
    throw new Error("telemetry payload parent does not match event parent");
  }
  if (computeBytesSha256(payloadJson) !== event.payloadSha256) {
    throw new Error("agent event payload hash mismatch");
  }
  const { eventSha256, ...unsigned } = event;
  if (computeBytesSha256(canonicalJson(unsigned)) !== eventSha256) {
    throw new Error("agent event hash mismatch");
  }
  if (previous === undefined) {
    if (event.sequenceNo !== 1 || event.previousEventSha256 !== null) {
      throw new Error("an event without its predecessor must be one-based genesis");
    }
    return;
  }
  if (event.flowId !== previous.flowId || event.sequenceNo !== previous.sequenceNo + 1 ||
      event.previousEventSha256 !== previous.eventSha256) {
    throw new Error("agent event chain mismatch");
  }
}

export function sanitizeTelemetryProjection(
  input: unknown,
  requirePayloadWrapper = false,
): Readonly<Record<string, unknown>> {
  assertJsonDocument(input);
  const value = plainRecord(input);
  if (value === null) throw new Error("telemetry payload must be an object");
  rejectForbiddenTelemetrySemantics(value);
  const sanitized = sanitizeResult(value);
  assertJsonDocument(sanitized);
  if (requirePayloadWrapper) validatePayloadWrapper(sanitized);
  const bytes = canonicalJson(sanitized);
  if (Buffer.byteLength(bytes, "utf8") > MAX_TELEMETRY_PAYLOAD_BYTES) {
    throw new Error("telemetry payload exceeds 4096 bytes (4 KiB)");
  }
  return deepFreeze(sanitized);
}

export function deriveAttemptTerminalEventId(input: {
  readonly flowId: string;
  readonly attemptId: string;
  readonly eventVersion: string;
}): string {
  assertExactKeys(input, new Set(["flowId", "attemptId", "eventVersion"]), "terminal event identity");
  assertTelemetryStableId(input.flowId, "flowId");
  assertTelemetryStableId(input.attemptId, "attemptId");
  assertTelemetryEventVersion(input.eventVersion);
  return computeBytesSha256(canonicalJson(input));
}

export function deriveUsageCoverageSha256(coveredAttemptIds: readonly string[]): string {
  if (!Array.isArray(coveredAttemptIds)) throw new Error("usage coverage must be an array");
  coveredAttemptIds.forEach((attemptId) =>
    assertTelemetryStableId(attemptId, "attemptId", "coverage attempt id"));
  if (new Set(coveredAttemptIds).size !== coveredAttemptIds.length) {
    throw new Error("usage coverage must contain unique attempt ids");
  }
  const sorted = [...coveredAttemptIds].sort(compareStrings);
  if (sorted.some((attemptId, index) => attemptId !== coveredAttemptIds[index])) {
    throw new Error("usage coverage must be sorted");
  }
  return computeBytesSha256(canonicalJson(coveredAttemptIds));
}

export function appendFlowEvent(input: FlowEventInput, previous?: FlowEvent): FlowEvent {
  if (!Number.isInteger(input.sequenceNo) || input.sequenceNo < 0) {
    throw new Error("event sequence must be a non-negative integer");
  }
  if (previous && (previous.flowId !== input.flowId || previous.sequenceNo + 1 !== input.sequenceNo)) {
    throw new Error("event sequence or flow chain mismatch");
  }
  const payloadBytes = canonicalJson(input.payload);
  if (Buffer.byteLength(payloadBytes) > MAX_TELEMETRY_PAYLOAD_BYTES) {
    throw new Error("event payload exceeds 4 KiB");
  }
  const unsigned = {
    schemaVersion: "FlowEvent/v1" as const,
    eventId: randomUUID(),
    ...structuredClone(input),
    previousEventHash: previous?.eventHash ?? null,
    payloadHash: computeBytesSha256(payloadBytes),
  };
  return deepFreeze({ ...unsigned, eventHash: computeBytesSha256(canonicalJson(unsigned)) });
}

export function verifyFlowEvent(event: FlowEvent, previous?: FlowEvent): void {
  const { eventHash, ...unsigned } = event;
  if (computeBytesSha256(canonicalJson(unsigned)) !== eventHash) throw new Error("flow event hash mismatch");
  if (computeBytesSha256(canonicalJson(event.payload)) !== event.payloadHash) {
    throw new Error("flow event payload hash mismatch");
  }
  if (Buffer.byteLength(canonicalJson(event.payload)) > MAX_TELEMETRY_PAYLOAD_BYTES) {
    throw new Error("event payload exceeds 4 KiB");
  }
  if (previous) {
    if (event.flowId !== previous.flowId || event.sequenceNo !== previous.sequenceNo + 1 ||
        event.previousEventHash !== previous.eventHash) {
      throw new Error("flow event chain mismatch");
    }
  } else if (event.sequenceNo !== 0 || event.previousEventHash !== null) {
    throw new Error("an event without its predecessor must be the initial event");
  }
}

function aggregateLegacyUsage(input: readonly UsageReceipt[]): AggregatedUsage {
  if (input.length === 0) {
    return { inputTokens: null, outputTokens: null, costMicroUsd: null, completeness: "unavailable" };
  }
  const receipts = deduplicateLegacyReceipts(input);
  receipts.forEach(validateLegacyReceipt);
  const self = receipts.filter((receipt) => (receipt.scope ?? "self") === "self");
  const attemptsWithSelf = new Set(self.map((receipt) => receipt.attemptId)
    .filter((id): id is string => id !== undefined));
  const selectedCoverage = new Set<string>();
  const subtree = receipts.filter((receipt) => receipt.scope === "subtree").sort((left, right) => {
    const length = (right.coveredAttemptIds?.length ?? 0) - (left.coveredAttemptIds?.length ?? 0);
    return length || compareStrings(String(left.receiptId ?? ""), String(right.receiptId ?? ""));
  });
  const selected: UsageReceipt[] = [...self];
  let missingCoverage = false;
  for (const receipt of subtree) {
    const covered = receipt.coveredAttemptIds;
    if (!covered || covered.length === 0) { missingCoverage = true; continue; }
    const uncovered = covered.filter((attemptId) => !attemptsWithSelf.has(attemptId));
    if (uncovered.length === 0) continue;
    if (uncovered.some((attemptId) => selectedCoverage.has(attemptId))) continue;
    uncovered.forEach((attemptId) => selectedCoverage.add(attemptId));
    selected.push(receipt);
  }
  const inputTokens = sumKnownLegacy(selected.map((receipt) => receipt.inputTokens));
  const outputTokens = sumKnownLegacy(selected.map((receipt) => receipt.outputTokens));
  const costMicroUsd = sumKnownLegacy(selected.map((receipt) => receipt.costMicroUsd));
  const anyKnown = inputTokens !== null || outputTokens !== null || costMicroUsd !== null;
  const incomplete = missingCoverage || selected.some((receipt) => receipt.completeness !== "exact" ||
    receipt.inputTokens === undefined || receipt.inputTokens === null ||
    receipt.outputTokens === undefined || receipt.outputTokens === null ||
    receipt.costMicroUsd === undefined || receipt.costMicroUsd === null);
  return {
    inputTokens,
    outputTokens,
    costMicroUsd,
    completeness: incomplete ? (anyKnown ? "partial" : "unavailable") : "exact",
  };
}

function aggregateDeterministicUsage(
  input: readonly UsageAggregationRecord[],
  attemptIds: readonly string[],
): DeterministicAggregatedUsage {
  const attempts = validateAttemptSet(attemptIds);
  const receipts = deduplicateAggregationRecords(input);
  receipts.forEach((receipt) => validateAggregationRecord(receipt, attempts));
  const selfOwners = new Set(receipts.filter((receipt) => receipt.scope === "self")
    .map((receipt) => receipt.attemptId));
  const selected: UsageAggregationRecord[] = [];
  const selectedSubtreeAttempts = new Set<string>();
  const skippedOverlapUsageIds: string[] = [];
  const candidates = receipts
    .filter((receipt) => receipt.scope === "subtree" && !selfOwners.has(receipt.attemptId))
    .sort((left, right) => {
      const size = logicalAttemptSet(right).size - logicalAttemptSet(left).size;
      return size || compareStrings(left.usageId, right.usageId);
    });
  for (const receipt of candidates) {
    const logical = logicalAttemptSet(receipt);
    if ([...logical].some((attemptId) => selectedSubtreeAttempts.has(attemptId))) {
      skippedOverlapUsageIds.push(receipt.usageId);
      continue;
    }
    selected.push(receipt);
    logical.forEach((attemptId) => selectedSubtreeAttempts.add(attemptId));
  }
  const self = receipts.filter((receipt) => receipt.scope === "self")
    .sort((left, right) => compareStrings(left.usageId, right.usageId));
  for (const receipt of self) {
    if (!selectedSubtreeAttempts.has(receipt.attemptId)) selected.push(receipt);
  }
  const selectedAttemptIds = new Set<string>();
  selected.forEach((receipt) => logicalAttemptSet(receipt)
    .forEach((attemptId) => selectedAttemptIds.add(attemptId)));
  const uncoveredAttemptIds = [...attempts].filter((attemptId) => !selectedAttemptIds.has(attemptId))
    .sort(compareStrings);
  const inputTokens = sumCompleteField(selected, "inputTokens");
  const outputTokens = sumCompleteField(selected, "outputTokens");
  const costMicroUsd = sumCompleteField(selected, "costMicroUsd");
  const anyKnown = inputTokens !== null || outputTokens !== null || costMicroUsd !== null;
  const incomplete = skippedOverlapUsageIds.length > 0 || uncoveredAttemptIds.length > 0 ||
    selected.some((receipt) => receipt.completeness !== "exact") ||
    inputTokens === null || outputTokens === null || costMicroUsd === null;
  return deepFreeze({
    inputTokens,
    outputTokens,
    costMicroUsd,
    completeness: !anyKnown ? "unavailable" : incomplete ? "partial" : "exact",
    selectedUsageIds: selected.map((receipt) => receipt.usageId).sort(compareStrings),
    skippedOverlapUsageIds: skippedOverlapUsageIds.sort(compareStrings),
    uncoveredAttemptIds,
  });
}

function validateEventHeader(input: AgentEventInput | (AgentEventEnvelope & { readonly payload: TelemetryPayload })): void {
  assertTelemetryStableId(input.eventId, "eventId");
  assertTelemetryStableId(input.flowId, "flowId");
  assertTelemetryEventType(input.eventType);
  assertTelemetryEventVersion(input.eventVersion);
  assertNullableTelemetryStableId(input.nodeId, "nodeId");
  assertNullableTelemetryStableId(input.attemptId, "attemptId");
  assertNullableTelemetryStableId(input.sessionId, "sessionId");
  assertNullableTelemetryStableId(input.parentSessionId, "parentSessionId");
  if (input.traceId !== null) assertTelemetryTraceId(input.traceId);
  if (input.spanId !== null) assertTelemetrySpanId(input.spanId);
  if (!Number.isSafeInteger(input.sequenceNo) || input.sequenceNo < 1) {
    throw new Error("agent event sequence must be a one-based safe integer");
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error("agent event createdAt must be a non-negative safe integer");
  }
  if (input.sequenceNo === 1) {
    if (input.previousEventSha256 !== null) throw new Error("genesis event cannot have a previous hash");
  } else if (typeof input.previousEventSha256 !== "string" || !SHA256.test(input.previousEventSha256)) {
    throw new Error("non-genesis event requires a previous event hash");
  }
}

function parseCanonicalTelemetryPayload(payloadJson: string): TelemetryPayload {
  if (typeof payloadJson !== "string") throw new Error("telemetry payload bytes must be a string");
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_TELEMETRY_PAYLOAD_BYTES) {
    throw new Error("telemetry payload exceeds 4096 bytes (4 KiB)");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(payloadJson); }
  catch { throw new Error("telemetry payload JSON is malformed"); }
  const sanitized = sanitizeTelemetryProjection(parsed, true) as unknown as TelemetryPayload;
  if (canonicalJson(sanitized) !== payloadJson) {
    throw new Error("telemetry payload bytes are not the canonical sanitized wrapper");
  }
  return sanitized;
}

function validatePayloadWrapper(value: Record<string, unknown>): asserts value is Record<string, unknown> & TelemetryPayload {
  assertExactKeys(value, PAYLOAD_KEYS, "telemetry payload wrapper");
  if (value.schemaVersion !== "TelemetryPayload/v1") throw new Error("unsupported telemetry payload wrapper");
  assertNullableTelemetryStableId(value.parentSessionId, "parentSessionId", "payload parentSessionId");
  if (plainRecord(value.data) === null) throw new Error("telemetry payload data must be an object");
}

function rejectForbiddenTelemetrySemantics(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenTelemetrySemantics);
    return;
  }
  const record = plainRecord(value);
  if (record === null) return;
  for (const [key, child] of Object.entries(record)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_TELEMETRY_KEYS.has(normalized)) {
      throw new Error(`telemetry payload contains forbidden ${key} semantics`);
    }
    rejectForbiddenTelemetrySemantics(child);
  }
}

function unavailableProviderUsage(status: "unavailable" | "invalid_provider_usage"): NormalizedProviderUsage {
  return deepFreeze({
    status,
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
}

function nullableProviderNumber(
  usage: Record<string, unknown>,
  key: ProviderUsageField,
): { readonly value: number | null; readonly invalid: boolean } {
  const value = usage[key];
  if (value === null || value === undefined) return { value: null, invalid: false };
  return typeof value === "number"
    ? { value, invalid: !Number.isFinite(value) }
    : { value: null, invalid: true };
}

function validateLegacyReceipt(receipt: UsageReceipt): void {
  if (!isUsageCompleteness(receipt.completeness)) throw new Error("usage completeness is invalid");
  for (const amount of [receipt.inputTokens, receipt.outputTokens, receipt.costMicroUsd]) {
    if (amount !== undefined && amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) {
      throw new Error("usage amount is invalid");
    }
  }
  if (receipt.completeness === "unavailable" &&
      [receipt.inputTokens, receipt.outputTokens, receipt.costMicroUsd]
        .some((amount) => amount !== undefined && amount !== null)) {
    throw new Error("unavailable usage cannot contain measured amounts");
  }
  if (receipt.scope === "subtree" && receipt.coveredAttemptIds &&
      new Set(receipt.coveredAttemptIds).size !== receipt.coveredAttemptIds.length) {
    throw new Error("subtree coverage contains duplicates");
  }
}

function validateAggregationRecord(receipt: UsageAggregationRecord, attempts: ReadonlySet<string>): void {
  assertTelemetryStableId(receipt.usageId, "usageId");
  assertTelemetryStableId(receipt.attemptId, "attemptId");
  assertTelemetryProvider(receipt.provider);
  assertProviderSessionIdentity(receipt.providerSessionId, "providerSessionId");
  assertTelemetryStableId(receipt.receiptId, "receiptId");
  if (!attempts.has(receipt.attemptId)) throw new Error("usage receipt owner is outside graph attempts");
  if (receipt.scope !== "self" && receipt.scope !== "subtree") throw new Error("usage receipt scope is invalid");
  if (!Array.isArray(receipt.coveredAttemptIds)) throw new Error("usage coverage must be an array");
  deriveUsageCoverageSha256(receipt.coveredAttemptIds);
  if (receipt.scope === "self" && receipt.coveredAttemptIds.length !== 0) {
    throw new Error("self usage receipt cannot contain subtree coverage");
  }
  if (receipt.scope === "subtree" && receipt.coveredAttemptIds.length === 0) {
    throw new Error("subtree usage receipt requires descendant coverage");
  }
  if (receipt.coveredAttemptIds.includes(receipt.attemptId)) {
    throw new Error("subtree coverage must not duplicate its owner attempt");
  }
  if (receipt.coveredAttemptIds.some((attemptId) => !attempts.has(attemptId))) {
    throw new Error("usage coverage is outside graph attempts");
  }
  if (!isUsageCompleteness(receipt.completeness)) throw new Error("usage completeness is invalid");
  const amounts = [receipt.inputTokens, receipt.outputTokens, receipt.costMicroUsd];
  for (const amount of amounts) {
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error("usage amount is invalid");
  }
  const known = amounts.filter((amount) => amount !== null).length;
  if ((receipt.completeness === "exact" && known !== 3) ||
      (receipt.completeness === "partial" && (known === 0 || known === 3)) ||
      (receipt.completeness === "unavailable" && known !== 0)) {
    throw new Error("usage completeness does not match known amounts");
  }
}

function deduplicateLegacyReceipts(receipts: readonly UsageReceipt[]): UsageReceipt[] {
  const seen = new Map<string, string>();
  const output: UsageReceipt[] = [];
  for (const receipt of receipts) {
    const hasIdentity = receipt.provider !== undefined && receipt.providerSessionId !== undefined &&
      receipt.attemptId !== undefined && receipt.receiptId !== undefined;
    if (!hasIdentity) { output.push(receipt); continue; }
    const key = `${receipt.provider}\0${receipt.providerSessionId}\0${receipt.attemptId}\0${receipt.receiptId}`;
    const bytes = canonicalJson(receipt);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== bytes) throw new Error("conflicting duplicate usage receipt");
    if (prior === undefined) { seen.set(key, bytes); output.push(receipt); }
  }
  return output;
}

function deduplicateAggregationRecords(input: readonly UsageAggregationRecord[]): UsageAggregationRecord[] {
  const natural = new Map<string, string>();
  const usageIds = new Map<string, string>();
  const output: UsageAggregationRecord[] = [];
  for (const receipt of input) {
    const bytes = canonicalJson(receipt);
    const key = `${receipt.provider}\0${receipt.providerSessionId}\0${receipt.attemptId}\0${receipt.receiptId}`;
    const priorNatural = natural.get(key);
    if (priorNatural !== undefined) {
      if (priorNatural !== bytes) throw new Error("conflicting duplicate natural receipt identity");
      continue;
    }
    const priorUsage = usageIds.get(receipt.usageId);
    if (priorUsage !== undefined && priorUsage !== bytes) {
      throw new Error("conflicting duplicate usage identity");
    }
    natural.set(key, bytes);
    usageIds.set(receipt.usageId, bytes);
    output.push(receipt);
  }
  const selfOwners = new Set<string>();
  for (const receipt of output) {
    if (receipt.scope === "self" && selfOwners.has(receipt.attemptId)) {
      throw new Error("duplicate self usage receipt for one attempt");
    }
    if (receipt.scope === "self") selfOwners.add(receipt.attemptId);
  }
  return output;
}

function validateAttemptSet(attemptIds: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(attemptIds)) throw new Error("graph attempt ids must be an array");
  attemptIds.forEach((attemptId) =>
    assertTelemetryStableId(attemptId, "attemptId", "graph attempt id"));
  const attempts = new Set(attemptIds);
  if (attempts.size !== attemptIds.length) throw new Error("graph attempt ids must be unique");
  return attempts;
}

function logicalAttemptSet(receipt: UsageAggregationRecord): ReadonlySet<string> {
  return new Set([receipt.attemptId, ...receipt.coveredAttemptIds]);
}

function sumCompleteField(
  receipts: readonly UsageAggregationRecord[],
  key: "inputTokens" | "outputTokens" | "costMicroUsd",
): number | null {
  if (receipts.length === 0 || receipts.some((receipt) => receipt[key] === null)) return null;
  let total = 0;
  for (const receipt of receipts) {
    total += receipt[key]!;
    if (!Number.isSafeInteger(total)) throw new Error("usage aggregate exceeds safe integer range");
  }
  return total;
}

function sumKnownLegacy(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => value !== null && value !== undefined);
  if (known.length === 0) return null;
  let total = 0;
  for (const value of known) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("usage aggregate exceeds safe integer range");
  }
  return total;
}

function assertExactKeys(value: object, expected: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(value);
  const unexpected = keys.find((key) => !expected.has(key));
  const missing = [...expected].find((key) => !Object.hasOwn(value, key));
  if (unexpected || missing) throw new Error(`${label} has an invalid field set`);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value as Record<string, unknown>
    : null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
