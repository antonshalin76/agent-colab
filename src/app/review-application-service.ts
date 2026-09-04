import { createHash, randomUUID } from "node:crypto";

import { REVIEW_BARRIER_POLICY } from "../domain/review.js";
import {
  REVIEW_PROVIDER_IDS,
  type ReviewProviderHealthSnapshot,
  type ReviewProviderId,
} from "../domain/routing.js";
import type { ReviewInput } from "../mcp/server.js";
import { ProviderHealthStore } from "../runtime/provider-health-store.js";
import {
  ReviewEvidenceCapture,
  type ReviewEvidenceCaptureEntryPoint,
  type ReviewEvidenceCaptureOutcome,
} from "../runtime/review-evidence-capture.js";
import { RunGateUnitOfWork } from "../runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import { ProjectPolicy } from "../security/project-policy.js";
import { redactSensitive } from "../security/redaction.js";
import { RunStore } from "../store/run-store.js";

const scopedIdempotencyKey = (project: string, key: string): string =>
  `${createHash("sha256").update(project).digest("hex").slice(0, 24)}:${key}`;

const reviewHealth = (snapshot: ReturnType<ProviderHealthStore["snapshot"]>) => ({
  grok: snapshot.grok.health,
  claude: snapshot.claude.health,
  codex: snapshot.codex.health,
}) as const;

export interface ReviewApplicationServiceDependencies {
  runs: RunStore;
  reviews: RunGateUnitOfWork;
  providers: ProviderHealthStore;
  projects: ProjectPolicy;
  evidenceCapture: ReviewEvidenceCapture;
}

export interface ReviewAdmission {
  health: ReviewProviderHealthSnapshot;
  sourceFingerprint: string;
  admissionEvidence: Array<{
    agent: ReviewProviderId;
    role: "auditor" | "critic";
    activationNonce: string;
    sourceReceiptId: string;
    readinessReceiptId: string;
    source: Record<string, unknown>;
    readiness: Record<string, unknown>;
    observedAt: number;
  }>;
  healthFailures: Array<{
    agent: ReviewProviderId;
    observedAt: number;
    outcome: ReviewEvidenceCaptureOutcome | null;
  }>;
}

export interface ReviewRequestResult {
  reviewId: string;
  laneCount: 6;
  activeLaneCount: number;
  runState: "FULL_CROSS_PROVIDER" | "DEGRADED_REVIEW_SET";
  runIds: string[];
}

export class ReviewApplicationService {
  private readonly inFlight = new Map<string, {
    signature: string;
    promise: Promise<ReviewRequestResult>;
  }>();

  constructor(private readonly dependencies: ReviewApplicationServiceDependencies) {}

  async status() {
    const runs = this.dependencies.runs.list();
    const providers = this.dependencies.providers.snapshot();
    return {
      providers: Object.fromEntries(REVIEW_PROVIDER_IDS.map((agent) => {
        const state = providers[agent];
        return [agent, {
          required: agent === REVIEW_BARRIER_POLICY.requiredAgent,
          health: state.health,
          capabilityVerified: state.capabilityVerified,
          retryAt: state.retryAt,
          failureCount: state.failureCount,
          attemptClaimed: state.attemptClaimed,
          updatedAt: state.updatedAt,
          recoveryGeneration: this.dependencies.providers.latestRecoveryGeneration(agent),
          deferredReviewCount: this.dependencies.reviews.deferredReviewIds(agent).length,
        }];
      })),
      reviewPolicy: {
        required: REVIEW_BARRIER_POLICY.requiredRoles.map(
          (role) => `${REVIEW_BARRIER_POLICY.requiredAgent}:${role}`,
        ),
        optional: REVIEW_BARRIER_POLICY.optionalAgents.flatMap(
          (agent) => REVIEW_BARRIER_POLICY.requiredRoles.map((role) => `${agent}:${role}`),
        ),
        optionalUnavailableBlocks: REVIEW_BARRIER_POLICY.optionalUnavailableBlocks,
        optionalChangesRequestedBlocks: REVIEW_BARRIER_POLICY.optionalChangesRequestedBlocks,
        optionalNeedsReconciliationBlocks: REVIEW_BARRIER_POLICY.optionalNeedsReconciliationBlocks,
      },
      queue: Object.fromEntries(
        ["queued", "claimed", "completed", "failed", "cancelled", "needs_reconciliation"]
          .map((status) => [status, runs.filter((run) => run.status === status).length]),
      ),
      protocol: "agent-collab-review-only/v1",
      capabilities: { reviewOnly: true },
    };
  }

  captureAdmission(
    entryPoint: Extract<ReviewEvidenceCaptureEntryPoint, "request_review" | "map_admission">,
    project: string,
    reviewId: string,
    expectedSourceFingerprint = captureWorkspaceFingerprint(project).fingerprint,
  ): ReviewAdmission {
    const { evidenceCapture, providers } = this.dependencies;
    const persisted = providers.snapshot();
    if (persisted.codex.health === "disabled") {
      throw new Error("mandatory Codex auditor/critic pair is disabled");
    }
    const outcomes = new Map<string, ReturnType<ReviewEvidenceCapture["capture"]>>();
    const unavailableForThisAdmission = new Set<ReviewProviderId>();
    const healthFailures: ReviewAdmission["healthFailures"] = [];
    for (const agent of ["grok", "claude", "codex"] as const) {
      if (persisted[agent].health === "disabled") continue;
      for (const role of ["auditor", "critic"] as const) {
        const outcome = evidenceCapture.capture({
          entryPoint,
          phase: "admission",
          project,
          agent,
          role,
        });
        outcomes.set(`${agent}:${role}`, outcome);
      }
      const auditor = outcomes.get(`${agent}:auditor`)!;
      const critic = outcomes.get(`${agent}:critic`)!;
      const pairIsEquivalent = auditor.kind === critic.kind &&
        auditor.kind !== "infrastructure_failure" &&
        critic.kind !== "infrastructure_failure" &&
        JSON.stringify(auditor.source) === JSON.stringify(critic.source) &&
        JSON.stringify(auditor.readiness) === JSON.stringify(critic.readiness);
      const pairIsReady = pairIsEquivalent && auditor.kind === "ready" && critic.kind === "ready" &&
        auditor.source.sourceFingerprint === expectedSourceFingerprint &&
        critic.source.sourceFingerprint === expectedSourceFingerprint;
      if (!pairIsReady) {
        const observedAt = Math.max(auditor.observedAt, critic.observedAt);
        const unavailable = [auditor, critic].find(
          (outcome) => outcome.kind === "provider_unavailable",
        ) ?? null;
        if (unavailable?.kind === "provider_unavailable" ||
            persisted[agent].health === "healthy") {
          healthFailures.push({ agent, observedAt, outcome: unavailable });
        }
        unavailableForThisAdmission.add(agent);
      }
    }
    const persistedHealth = reviewHealth(persisted);
    const health: ReviewProviderHealthSnapshot = {
      ...persistedHealth,
      ...Object.fromEntries(
        [...unavailableForThisAdmission].map((agent) => [agent, "unavailable"]),
      ),
    } as ReviewProviderHealthSnapshot;
    const admissionEvidence: ReviewAdmission["admissionEvidence"] = [];
    for (const agent of ["grok", "claude", "codex"] as const) {
      if (health[agent] !== "healthy" || unavailableForThisAdmission.has(agent)) continue;
      for (const role of ["auditor", "critic"] as const) {
        const outcome = outcomes.get(`${agent}:${role}`)!;
        if (outcome.kind !== "ready") {
          throw new Error(`healthy review provider lacks ready evidence: ${agent}/${role}`);
        }
        const activationNonce = randomUUID();
        const sourceReceiptId = randomUUID();
        const readinessReceiptId = randomUUID();
        admissionEvidence.push({
          agent,
          role,
          activationNonce,
          sourceReceiptId,
          readinessReceiptId,
          source: outcome.source,
          readiness: outcome.readiness,
          observedAt: outcome.observedAt,
        });
      }
    }
    return {
      health,
      sourceFingerprint: expectedSourceFingerprint,
      admissionEvidence,
      healthFailures,
    };
  }

  applyAdmissionFailures(admission: ReviewAdmission): void {
    for (const failure of admission.healthFailures) {
      if (failure.outcome?.kind === "provider_unavailable") {
        this.dependencies.providers.applyCaptureOutcome(failure.outcome);
      } else {
        this.dependencies.providers.recordFailoverFailure(
          failure.agent,
          { kind: "model_unavailable" },
          failure.observedAt,
        );
      }
    }
  }

  reviewRuns(reviewId: string, requester: "grok" | "codex") {
    return this.dependencies.reviews.enqueueDescriptors(reviewId).map((lane) => {
      if (lane.requester !== requester) {
        throw new Error("review requester changed before durable enqueue");
      }
      const run = this.dependencies.runs.getByIdempotencyKey(lane.idempotencyKey);
      if (!run) throw new Error("atomic review run is missing");
      return run;
    });
  }

  private response(review: ReturnType<RunGateUnitOfWork["get"]> & {}): ReviewRequestResult {
    const runIds = this.dependencies.reviews.initialRunIds(review.reviewId);
    return {
      reviewId: review.reviewId,
      laneCount: 6,
      activeLaneCount: runIds.length,
      runState: review.runState,
      runIds,
    };
  }

  async requestReview(input: ReviewInput): Promise<ReviewRequestResult> {
    if (input.requester !== "codex") {
      throw new Error("only Codex may mint a review grant at the local stdio boundary");
    }
    const project = this.dependencies.projects.resolveReviewWorkspace(input.workspaceRoot);
    if (input.approvalScope !== "workspace-read") {
      throw new Error("review lanes are immutable read-only operations");
    }
    if (redactSensitive(input.artifactContent) !== input.artifactContent) {
      throw new Error("review artifact contains credential material and cannot preserve its exact hash safely");
    }
    const artifact = Buffer.from(input.artifactContent, "utf8");
    const actualHash = createHash("sha256").update(artifact).digest("hex");
    if (actualHash !== input.artifactHash) throw new Error("review artifact hash mismatch");
    const reviewId = scopedIdempotencyKey(project, input.idempotencyKey);
    const safePrompt = redactSensitive(input.prompt);
    const source = captureWorkspaceFingerprint(project);
    const exact = {
      reviewId,
      stageId: input.stageId ?? "independent-review",
      artifact,
      approvalScope: "workspace-read",
      idempotencyKey: reviewId,
      prompts: {
        auditor: `AUDITOR independent lane. ${safePrompt}`,
        critic: `CRITIC independent lane. ${safePrompt}`,
      },
      project,
      requester: input.requester,
      sourceFingerprint: source.fingerprint,
      changedFiles: source.changedFiles.length,
    } as const;
    const existing = this.dependencies.reviews.findExact(exact);
    if (existing) return this.response(existing);

    const signature = createHash("sha256").update(JSON.stringify({
      stageId: exact.stageId,
      artifactHash: actualHash,
      prompts: exact.prompts,
      project,
      requester: input.requester,
      sourceFingerprint: source.fingerprint,
      changedFiles: source.changedFiles.length,
    })).digest("hex");
    const pending = this.inFlight.get(reviewId);
    if (pending) {
      if (pending.signature !== signature) throw new Error(`Immutable review conflict: ${reviewId}`);
      return pending.promise;
    }

    const promise = (async (): Promise<ReviewRequestResult> => {
      const replay = this.dependencies.reviews.findExact(exact);
      if (replay) return this.response(replay);
      const admission = this.captureAdmission(
        "request_review",
        project,
        reviewId,
        source.fingerprint,
      );
      const result = this.dependencies.reviews.createWithResult({
        ...exact,
        health: admission.health,
        createdAt: Date.now(),
        admissionEvidence: admission.admissionEvidence,
      });
      if (result.created) this.applyAdmissionFailures(admission);
      return this.response(result.review);
    })();
    this.inFlight.set(reviewId, { signature, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(reviewId)?.promise === promise) this.inFlight.delete(reviewId);
    }
  }

  async reviewStatus(input: { reviewId: string }) {
    const review = this.dependencies.reviews.get(input.reviewId);
    if (!review) throw new Error(`Unknown review: ${input.reviewId}`);
    return { review, barrier: this.dependencies.reviews.barrier(input.reviewId) };
  }
}
