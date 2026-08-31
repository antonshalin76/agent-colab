import type { ProviderHealthStore } from "./provider-health-store.js";
import type { RunRecord } from "../store/run-store.js";
import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import type { ReviewEvidenceCapture } from "./review-evidence-capture.js";
import type { RunGateUnitOfWork } from "./run-gate-unit-of-work.js";

const evidenceHash = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("prelaunch evidence must be JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const isReviewProviderId = (value: unknown): value is "grok" | "claude" | "codex" =>
  value === "grok" || value === "claude" || value === "codex";

export async function executeReviewLaunchWithFence(input: {
  run: RunRecord;
  health: ProviderHealthStore;
  observedAt: number;
  evidenceCapture?: ReviewEvidenceCapture;
  capturePrelaunch?: (input: Record<string, unknown>) => Record<string, unknown>;
  reviews?: Pick<RunGateUnitOfWork, "applyPrelaunchFence"> &
    Partial<Pick<RunGateUnitOfWork, "receiptCursor" | "captureReviewReceipt">>;
  reconcile?: (reason: string) => void;
  launch: (spawnAuthority?: unknown) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const decision = input.run.payload?.decision as { agent?: unknown } | undefined;
  const agent = decision?.agent;
  const reviewId = input.run.payload?.reviewId;
  const attemptId = input.run.payload?.reviewAttemptId;
  const attemptOrdinal = input.run.payload?.reviewAttemptOrdinal;
  const role = input.run.payload?.reviewRole;
  const reviewShaped = (typeof input.run.stage === "string" && input.run.stage.startsWith("review:")) ||
    reviewId !== undefined ||
    attemptId !== undefined || attemptOrdinal !== undefined || role !== undefined ||
    input.run.payload?.reviewDispatchIdentity !== undefined;
  const complete = isReviewProviderId(agent) && typeof reviewId === "string" &&
    typeof attemptId === "string" && Number.isSafeInteger(attemptOrdinal) &&
    (role === "auditor" || role === "critic");
  if (!reviewShaped) {
    return { status: "launched", providerResult: await input.launch() };
  }
  if (!complete) {
    input.reconcile?.("partial review dispatch identity");
    return { status: "needs_reconciliation", duplicateSpawnPrevented: true };
  }
  if (input.run.launched) {
    return { status: "needs_reconciliation", duplicateSpawnPrevented: true };
  }
  if (!input.reviews || (!input.evidenceCapture && !input.capturePrelaunch)) {
    return { status: "rejected", providerResult: { kind: "model_unavailable", agent } };
  }
  let prelaunch: Record<string, unknown>;
  if (input.evidenceCapture) {
    const project = input.run.payload?.project;
    if (typeof project !== "string") {
      input.reconcile?.("review dispatch lacks project for typed prelaunch capture");
      return { status: "needs_reconciliation", duplicateSpawnPrevented: true };
    }
    const outcome = input.evidenceCapture.capture({ entryPoint: "prelaunch", phase: "prelaunch",
      project, agent, role });
    const applied = input.health.applyCaptureOutcome(outcome);
    void applied;
    if (outcome.kind === "infrastructure_failure") {
      input.reconcile?.("prelaunch evidence infrastructure failure");
      return { status: "needs_reconciliation", providerResult: outcome };
    }
    if (!input.reviews.receiptCursor || !input.reviews.captureReviewReceipt) {
      input.reconcile?.("typed prelaunch receipt ledger is unavailable");
      return { status: "needs_reconciliation", providerResult: outcome };
    }
    const scope = `attempt/${attemptId}/prelaunch`;
    const cursor = input.reviews.receiptCursor(scope);
    const receiptId = randomUUID();
    const observation = { source: outcome.source, readiness: outcome.readiness,
      sourceObservationHash: evidenceHash(outcome.source),
      readinessObservationHash: evidenceHash(outcome.readiness) };
    input.reviews.captureReviewReceipt({ receiptId, phase: "prelaunch", scope,
      scopeRevision: cursor.scopeRevision, activationNonce: randomUUID(),
      expectedTuple: { attemptId }, recoveryGeneration: null, observation,
      predecessorReceiptId: cursor.predecessorReceiptId, createdAt: outcome.observedAt });
    prelaunch = { prelaunchReceiptId: receiptId, outcome };
  } else {
    prelaunch = input.capturePrelaunch!({
      runId: input.run.id, reviewId, attemptId, role, agent, observedAt: input.observedAt,
      health: input.health.get(agent),
    });
  }
  const prelaunchReceiptId = prelaunch.prelaunchReceiptId ?? prelaunch.receiptId ??
    prelaunch.sourceReceiptId;
  if (typeof prelaunchReceiptId !== "string") {
    input.reconcile?.("prelaunch capture did not produce a receipt");
    return { status: "needs_reconciliation", duplicateSpawnPrevented: true };
  }
  const fence = input.reviews.applyPrelaunchFence({
    runId: input.run.id, reviewId, attemptId, attemptOrdinal: Number(attemptOrdinal), role, agent,
    prelaunchReceiptId,
    now: input.observedAt,
  });
  const capturedOutcome = prelaunch.outcome as Record<string, unknown> | undefined;
  if (capturedOutcome?.kind === "provider_unavailable") {
    return { status: "rejected", providerResult: capturedOutcome, prelaunchFence: fence };
  }
  if (fence.status !== "authorized" || !fence.spawnAuthority) {
    return { status: "rejected", providerResult: { kind: "model_unavailable", agent,
      prelaunchFence: fence } };
  }
  return {
    status: "launched",
    providerResult: await input.launch(fence.spawnAuthority),
    spawnAuthority: fence.spawnAuthority,
  };
}
