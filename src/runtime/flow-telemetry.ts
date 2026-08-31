import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../workflow/flow-contract.js";
import type { UsageCompleteness } from "./node-result.js";

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

export interface AggregatedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costMicroUsd: number | null;
  readonly completeness: UsageCompleteness;
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

export function aggregateUsage(input: readonly UsageReceipt[]): AggregatedUsage {
  if (input.length === 0) return { inputTokens: null, outputTokens: null, costMicroUsd: null, completeness: "unavailable" };
  const receipts = deduplicateReceipts(input);
  receipts.forEach(validateReceipt);

  const self = receipts.filter((receipt) => (receipt.scope ?? "self") === "self");
  const attemptsWithSelf = new Set(self.map((receipt) => receipt.attemptId).filter((id): id is string => id !== undefined));
  const selectedCoverage = new Set<string>();
  const subtree = receipts.filter((receipt) => receipt.scope === "subtree").sort((left, right) => {
    const length = (right.coveredAttemptIds?.length ?? 0) - (left.coveredAttemptIds?.length ?? 0);
    return length || String(left.receiptId ?? "").localeCompare(String(right.receiptId ?? ""));
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

  const inputTokens = sumNullable(selected.map((receipt) => receipt.inputTokens));
  const outputTokens = sumNullable(selected.map((receipt) => receipt.outputTokens));
  const costMicroUsd = sumNullable(selected.map((receipt) => receipt.costMicroUsd));
  const anyKnown = inputTokens !== null || outputTokens !== null || costMicroUsd !== null;
  const incomplete = missingCoverage || selected.some((receipt) => receipt.completeness !== "exact"
    || receipt.inputTokens === undefined || receipt.inputTokens === null
    || receipt.outputTokens === undefined || receipt.outputTokens === null
    || receipt.costMicroUsd === undefined || receipt.costMicroUsd === null);
  const completeness: UsageCompleteness = incomplete ? (anyKnown ? "partial" : "unavailable") : "exact";
  return { inputTokens, outputTokens, costMicroUsd, completeness };
}

export function appendFlowEvent(input: FlowEventInput, previous?: FlowEvent): FlowEvent {
  if (!Number.isInteger(input.sequenceNo) || input.sequenceNo < 0) throw new Error("event sequence must be a non-negative integer");
  if (previous && (previous.flowId !== input.flowId || previous.sequenceNo + 1 !== input.sequenceNo)) throw new Error("event sequence or flow chain mismatch");
  const payloadBytes = canonicalJson(input.payload);
  if (Buffer.byteLength(payloadBytes) > 4096) throw new Error("event payload exceeds 4 KiB");
  const unsigned = {
    schemaVersion: "FlowEvent/v1" as const,
    eventId: randomUUID(),
    ...structuredClone(input),
    previousEventHash: previous?.eventHash ?? null,
    payloadHash: digest(payloadBytes),
  };
  return deepFreeze({ ...unsigned, eventHash: digest(canonicalJson(unsigned)) });
}

export function verifyFlowEvent(event: FlowEvent, previous?: FlowEvent): void {
  const { eventHash, ...unsigned } = event;
  if (digest(canonicalJson(unsigned)) !== eventHash) throw new Error("flow event hash mismatch");
  if (digest(canonicalJson(event.payload)) !== event.payloadHash) throw new Error("flow event payload hash mismatch");
  if (Buffer.byteLength(canonicalJson(event.payload)) > 4096) throw new Error("event payload exceeds 4 KiB");
  if (previous) {
    if (event.flowId !== previous.flowId || event.sequenceNo !== previous.sequenceNo + 1 || event.previousEventHash !== previous.eventHash) throw new Error("flow event chain mismatch");
  } else if (event.sequenceNo !== 0 || event.previousEventHash !== null) {
    throw new Error("an event without its predecessor must be the initial event");
  }
}

function validateReceipt(receipt: UsageReceipt): void {
  if (!["exact", "partial", "unavailable"].includes(receipt.completeness)) throw new Error("usage completeness is invalid");
  for (const amount of [receipt.inputTokens, receipt.outputTokens, receipt.costMicroUsd]) {
    if (amount !== undefined && amount !== null && (!Number.isInteger(amount) || amount < 0)) throw new Error("usage amount is invalid");
  }
  if (receipt.completeness === "unavailable" && [receipt.inputTokens, receipt.outputTokens, receipt.costMicroUsd].some((amount) => amount !== undefined && amount !== null)) {
    throw new Error("unavailable usage cannot contain measured amounts");
  }
  if (receipt.scope === "subtree" && receipt.coveredAttemptIds && new Set(receipt.coveredAttemptIds).size !== receipt.coveredAttemptIds.length) throw new Error("subtree coverage contains duplicates");
}

function deduplicateReceipts(receipts: readonly UsageReceipt[]): UsageReceipt[] {
  const seen = new Map<string, string>();
  const output: UsageReceipt[] = [];
  for (const receipt of receipts) {
    const hasIdentity = receipt.provider !== undefined && receipt.providerSessionId !== undefined && receipt.attemptId !== undefined && receipt.receiptId !== undefined;
    if (!hasIdentity) { output.push(receipt); continue; }
    const key = `${receipt.provider}\0${receipt.providerSessionId}\0${receipt.attemptId}\0${receipt.receiptId}`;
    const bytes = canonicalJson(receipt);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== bytes) throw new Error("conflicting duplicate usage receipt");
    if (prior === undefined) { seen.set(key, bytes); output.push(receipt); }
  }
  return output;
}

function sumNullable(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => value !== null && value !== undefined);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
