import type { ProviderOutcome } from "../domain/outcomes.js";
import { REVIEW_PROVIDER_IDS, type ReviewProviderId } from "../domain/routing.js";
import type { ReviewEvidenceCapture } from "./review-evidence-capture.js";
import type { ProviderHealthStore } from "./provider-health-store.js";
import { activateRecoveredReviewLanes, type ReviewRejoinResult } from "./review-rejoin.js";
import type { RunGateUnitOfWork } from "./run-gate-unit-of-work.js";

export interface AutomaticProviderProbeResult {
  readonly ready: boolean;
  readonly failure?: ProviderOutcome;
}

export interface ProviderRecoveryResult {
  readonly agent: ReviewProviderId;
  readonly status: "not_due" | "recovered" | "rejoined" | "unavailable";
  readonly generation: number;
  readonly rejoin?: ReviewRejoinResult;
}

const activeRecoveryDemand = (
  reviews: RunGateUnitOfWork,
  agent: ReviewProviderId,
): string[] => reviews.deferredReviewIds(agent).filter((reviewId) => {
  try { return !reviews.barrier(reviewId).satisfied; } catch { return false; }
});

export async function runAutomaticProviderRecovery(input: {
  now: number;
  health: ProviderHealthStore;
  reviews: RunGateUnitOfWork;
  evidenceCapture: ReviewEvidenceCapture;
  probe: (agent: ReviewProviderId, signal?: AbortSignal) => Promise<AutomaticProviderProbeResult>;
  agents?: readonly ReviewProviderId[];
  signal?: AbortSignal;
}): Promise<readonly ProviderRecoveryResult[]> {
  const agents = input.agents ?? REVIEW_PROVIDER_IDS;
  return Promise.all(agents.map(async (agent): Promise<ProviderRecoveryResult> => {
    const demandedReviewIds = activeRecoveryDemand(input.reviews, agent);
    if (demandedReviewIds.length === 0) {
      return { agent, status: "not_due",
        generation: input.health.latestRecoveryGeneration(agent) };
    }
    let admission = input.health.acquireRecoveryProbeAdmission(agent, input.now);
    if (!admission.runnable || admission.claimedAt === undefined) {
      const generation = input.health.latestRecoveryGeneration(agent);
      const current = input.health.get(agent);
      if (current.health === "healthy" && current.capabilityVerified && generation > 0 &&
          input.reviews.hasUnconsumedRecoveryGeneration(agent, generation)) {
        const rejoin = activateRecoveredReviewLanes({
          agent, now: input.now, reviews: input.reviews, health: input.health,
          evidenceCapture: input.evidenceCapture,
        });
        const stillDemanded = activeRecoveryDemand(input.reviews, agent).length > 0;
        if (stillDemanded && input.health.get(agent).health === "healthy") {
          input.health.recordFailoverFailure(agent, { kind: "model_unavailable" }, input.now);
          return { agent, status: "unavailable", generation, rejoin };
        }
        return { agent, status: "rejoined", generation, rejoin };
      }
      if (current.health !== "healthy" || !current.capabilityVerified) {
        return { agent, status: "not_due", generation };
      }
      admission = input.health.acquireExplicitProbeAdmission(agent, input.now);
      if (!admission.runnable || admission.claimedAt === undefined) {
        return { agent, status: "not_due", generation };
      }
    }
    let observed: AutomaticProviderProbeResult;
    try {
      if (input.signal?.aborted) throw input.signal.reason;
      observed = await input.probe(agent, input.signal);
      if (input.signal?.aborted) throw input.signal.reason;
    } catch (error) {
      if (input.signal?.aborted) {
        input.health.releaseAttempt(agent, input.now, admission.claimedAt);
        throw error;
      }
      observed = { ready: false, failure: { kind: "model_unavailable" } };
    }
    if (!observed.ready) {
      input.health.recordFailoverFailure(agent,
        observed.failure ?? { kind: "model_unavailable" }, input.now, admission.claimedAt);
      return { agent, status: "unavailable",
        generation: input.health.latestRecoveryGeneration(agent) };
    }
    input.health.recordSuccess(agent, input.now, admission.claimedAt);
    const generation = input.health.latestRecoveryGeneration(agent);
    const rejoin = activateRecoveredReviewLanes({
      agent, now: input.now, reviews: input.reviews, health: input.health,
      evidenceCapture: input.evidenceCapture,
    });
    const stillDemanded = activeRecoveryDemand(input.reviews, agent).length > 0;
    if (stillDemanded && input.health.get(agent).health === "healthy") {
      input.health.recordFailoverFailure(agent, { kind: "model_unavailable" }, input.now);
      return { agent, status: "unavailable", generation, rejoin };
    }
    return { agent, status: "recovered", generation, rejoin };
  }));
}
