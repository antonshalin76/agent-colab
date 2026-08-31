import type { ReviewProviderId } from "../domain/routing.js";
import type { ProviderHealthStore } from "./provider-health-store.js";
import type { RunGateUnitOfWork } from "./run-gate-unit-of-work.js";
import { randomUUID } from "node:crypto";
import type { ReviewEvidenceCapture } from "./review-evidence-capture.js";

export interface ReviewRejoinResult {
  activated: number;
  stale: number;
  skippedUnreadableProject: number;
  skippedSatisfied: number;
  skippedHarnessUnavailable: number;
}

export function activateRecoveredReviewLanes(input: {
  agent: ReviewProviderId;
  now: number;
  reviews: RunGateUnitOfWork;
  health: ProviderHealthStore;
  evidenceCapture?: ReviewEvidenceCapture;
  harnessReady?: unknown;
  captureFingerprint?: unknown;
  captureAdmissionPair?: unknown;
}): ReviewRejoinResult {
  const raw = input as unknown as Record<string, unknown>;
  if ("harnessReady" in raw || "captureFingerprint" in raw || "captureAdmissionPair" in raw) {
    throw new Error("legacy raw rejoin evidence overload is unsupported");
  }
  if (!input.evidenceCapture) throw new Error("typed rejoin evidence capture is required");
  const evidenceCapture = input.evidenceCapture;
  const result: ReviewRejoinResult = {
    activated: 0,
    stale: 0,
    skippedUnreadableProject: 0,
    skippedSatisfied: 0,
    skippedHarnessUnavailable: 0,
  };
  const reviewIds = input.reviews.deferredReviewIds(input.agent);
  for (const reviewId of reviewIds) {
    const snapshot = input.reviews.get(reviewId);
    if (!snapshot) continue;
    if (input.reviews.barrier(reviewId).satisfied) {
      result.skippedSatisfied += 1;
      continue;
    }
    if (!snapshot.project) { result.skippedUnreadableProject += 1; continue; }
    const admissionReceipts = snapshot.lanes
      .filter((lane) => lane.agent === input.agent && lane.status === "deferred")
      .flatMap((lane) => {
        const outcome = evidenceCapture.capture({ entryPoint: "recovery_rejoin",
          phase: "admission", project: snapshot.project!, agent: input.agent, role: lane.role });
        if (outcome.kind === "infrastructure_failure") return [];
        input.health.applyCaptureOutcome(outcome);
        if (outcome.kind !== "ready") {
          result.skippedHarnessUnavailable += 1;
          return [];
        }
        const generation = input.health.latestRecoveryGeneration(input.agent);
        if (!generation) return [];
        const sourceScope = `review/${reviewId}/${input.agent}/${lane.role}/source`;
        const readinessScope = `review/${reviewId}/${input.agent}/${lane.role}/readiness`;
        const cursor = input.reviews.receiptPairCursor({ sourceScope, readinessScope });
        const activationNonce = randomUUID();
        const sourceReceiptId = randomUUID();
        const readinessReceiptId = randomUUID();
        const captured = input.reviews.captureReviewReceiptPair({ pairId: randomUUID(),
          phase: "admission", activationNonce, scopeRevision: cursor.scopeRevision,
          recoveryGeneration: generation,
          expectedTuple: input.reviews.admissionTuple(reviewId, input.agent, lane.role),
          predecessorReceiptIds: cursor.predecessorReceiptIds,
          receipts: {
            source: { receiptId: sourceReceiptId, scope: sourceScope, observation: outcome.source },
            readiness: { receiptId: readinessReceiptId, scope: readinessScope,
              observation: outcome.readiness },
          }, createdAt: outcome.observedAt });
        if (captured.lifecycle !== "pending") return [];
        return [{ agent: input.agent, role: lane.role, activationNonce,
          sourceReceiptId, readinessReceiptId }];
      });
    if (admissionReceipts.length === 0) continue;
    const generation = input.health.latestRecoveryGeneration(input.agent);
    if (!generation) continue;
    const activation = input.reviews.activateDeferred({ reviewId, agent: input.agent,
      now: input.now, recoveryGeneration: generation,
      admissionReceipts: admissionReceipts as never });
    if (activation.status === "activated") result.activated += activation.lanes.length;
    if (activation.status === "stale_artifact") result.stale += 1;
  }
  return result;
}
