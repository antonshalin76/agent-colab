import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewApplicationService } from "../src/app/review-application-service.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import { runAutomaticProviderRecovery } from "../src/runtime/provider-recovery-loop.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { ProjectPolicy } from "../src/security/project-policy.js";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable review recovery observability", () => {
  it("projects sanitized provider recovery state and persisted recovered-attempt lineage", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-review-observability-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const database = join(root, "state.db");
    initializeCurrentExecutionSchema(database);
    const runs = new RunStore(database, { scope: "review" });
    const reviews = new RunGateUnitOfWork(database);
    const providers = new ProviderHealthStore(database, { cooldownMs: 1_000 });
    for (const agent of ["grok", "claude", "codex"] as const) providers.recordSuccess(agent, 1);
    const fingerprint = captureWorkspaceFingerprint(project).fingerprint;
    const admissionCapture = new ReviewEvidenceCapture({
      captureSource: () => ({ sourceFingerprint: fingerprint, valid: true }),
      captureReadiness: ({ agent }) => agent === "claude"
        ? { harnessReady: false, state: "provider_unavailable", valid: false }
        : { harnessReady: true, state: "ready", valid: true },
      observedAt: () => 100,
    });
    const service = new ReviewApplicationService({
      runs,
      reviews,
      providers,
      projects: new ProjectPolicy([root]),
      evidenceCapture: admissionCapture,
    });

    try {
      const artifactContent = "observable immutable review";
      const requested = await service.requestReview({
        requester: "codex",
        workspaceRoot: project,
        artifactContent,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        prompt: "review",
        approvalScope: "workspace-read",
        idempotencyKey: "observable-recovery",
      });

      const degradedStatus = await service.status();
      expect(degradedStatus).toMatchObject({
        providers: {
          codex: {
            required: true,
            health: "healthy",
            capabilityVerified: true,
            retryAt: null,
            failureCount: 0,
            attemptClaimed: false,
            updatedAt: 1,
            recoveryGeneration: 0,
            deferredReviewCount: 0,
          },
          grok: {
            required: false,
            health: "healthy",
            recoveryGeneration: 0,
            deferredReviewCount: 0,
          },
          claude: {
            required: false,
            health: "unavailable",
            capabilityVerified: false,
            retryAt: 1_100,
            failureCount: 1,
            attemptClaimed: false,
            updatedAt: 100,
            recoveryGeneration: 0,
            deferredReviewCount: 1,
          },
        },
      });
      for (const provider of Object.values(degradedStatus.providers)) {
        expect(Object.keys(provider).sort()).toEqual([
          "attemptClaimed",
          "capabilityVerified",
          "deferredReviewCount",
          "failureCount",
          "health",
          "recoveryGeneration",
          "required",
          "retryAt",
          "updatedAt",
        ]);
      }

      const recoveryCapture = new ReviewEvidenceCapture({
        captureSource: () => ({ sourceFingerprint: fingerprint, valid: true }),
        captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
        observedAt: () => 1_101,
      });
      await expect(runAutomaticProviderRecovery({
        now: 1_100,
        health: providers,
        reviews,
        evidenceCapture: recoveryCapture,
        agents: ["claude"],
        probe: async () => ({ ready: true }),
      })).resolves.toMatchObject([{ status: "recovered", generation: 1 }]);

      await expect(service.status()).resolves.toMatchObject({
        providers: {
          claude: {
            required: false,
            health: "healthy",
            capabilityVerified: true,
            retryAt: null,
            failureCount: 0,
            attemptClaimed: false,
            updatedAt: 1_100,
            recoveryGeneration: 1,
            deferredReviewCount: 0,
          },
        },
      });
      const status = await service.reviewStatus({ reviewId: requested.reviewId });
      const recovered = status.review.lanes
        .filter((lane) => lane.agent === "claude")
        .flatMap((lane) => lane.attempts);
      expect(recovered).toHaveLength(2);
      expect(recovered.every((attempt) => attempt.recoveryGeneration === 1 &&
        attempt.attemptOrdinal === 0 && typeof attempt.authorityId === "string")).toBe(true);
    } finally {
      providers.close();
      reviews.close();
      runs.close();
    }
  });
});
