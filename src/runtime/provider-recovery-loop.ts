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

export async function runAutomaticProviderRecovery(input: {
  now: number;
  health: ProviderHealthStore;
  reviews: RunGateUnitOfWork;
  evidenceCapture: ReviewEvidenceCapture;
  probe: (agent: ReviewProviderId) => Promise<AutomaticProviderProbeResult>;
  agents?: readonly ReviewProviderId[];
}): Promise<readonly ProviderRecoveryResult[]> {
  const agents = input.agents ?? REVIEW_PROVIDER_IDS;
  return Promise.all(agents.map(async (agent): Promise<ProviderRecoveryResult> => {
    const admission = input.health.acquireRecoveryProbeAdmission(agent, input.now);
    if (!admission.runnable || admission.claimedAt === undefined) {
      const generation = input.health.latestRecoveryGeneration(agent);
      const current = input.health.get(agent);
      if (current.health === "healthy" && current.capabilityVerified && generation > 0 &&
          input.reviews.deferredReviewIds(agent).length > 0) {
        const rejoin = activateRecoveredReviewLanes({
          agent, now: input.now, reviews: input.reviews, health: input.health,
          evidenceCapture: input.evidenceCapture,
        });
        return { agent, status: "rejoined", generation, rejoin };
      }
      return { agent, status: "not_due", generation };
    }
    let observed: AutomaticProviderProbeResult;
    try {
      observed = await input.probe(agent);
    } catch {
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
    return { agent, status: "recovered", generation, rejoin };
  }));
}
