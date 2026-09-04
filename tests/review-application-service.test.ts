import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewApplicationService } from "../src/app/review-application-service.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { runAutomaticProviderRecovery } from "../src/runtime/provider-recovery-loop.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import type { ReviewEvidenceCaptureInput } from "../src/runtime/review-evidence-capture.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { ProjectPolicy } from "../src/security/project-policy.js";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];

const fixture = (capture?: {
  source?: (input: ReviewEvidenceCaptureInput, projectFingerprint: string) => unknown;
  readiness?: (input: ReviewEvidenceCaptureInput) => unknown;
}) => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-application-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const database = join(root, "state.db");
  initializeCurrentExecutionSchema(database);
  const allRuns = new RunStore(database);
  const reviewRuns = new RunStore(database, { scope: "review" });
  const reviews = new RunGateUnitOfWork(database);
  const providers = new ProviderHealthStore(database, { cooldownMs: 60_000 });
  for (const agent of ["grok", "claude", "codex"] as const) providers.recordSuccess(agent, 1);
  const service = new ReviewApplicationService({
    runs: reviewRuns,
    reviews,
    providers,
    projects: new ProjectPolicy([root]),
    evidenceCapture: new ReviewEvidenceCapture({
      captureSource: (input) => {
        const fingerprint = captureWorkspaceFingerprint(input.project).fingerprint;
        return capture?.source?.(input, fingerprint) ?? {
          sourceFingerprint: fingerprint,
          valid: true,
        };
      },
      captureReadiness: (input) => capture?.readiness?.(input) ??
        ({ harnessReady: true, state: "ready", valid: true }),
      observedAt: () => 100,
    }),
  });
  return { project, allRuns, reviewRuns, reviews, providers, service };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ReviewApplicationService", () => {
  it("returns only review aggregates and counts only exactly linked review runs", async () => {
    const { project, allRuns, reviewRuns, reviews, providers, service } = fixture();
    try {
      const generic = allRuns.enqueue({
        idempotencyKey: "generic-run",
        stage: "implementation",
        priority: 10,
      });
      const unlinkedReview = allRuns.enqueue({
        idempotencyKey: "unlinked-review-shaped-run",
        stage: "review:auditor",
        priority: 10,
      });
      await expect(service.reviewStatus({ reviewId: generic.id })).rejects.toThrow(/unknown review/i);
      await expect(service.reviewStatus({ reviewId: unlinkedReview.id })).rejects.toThrow(/unknown review/i);

      const artifactContent = "immutable review application artifact";
      const result = await service.requestReview({
        requester: "codex",
        workspaceRoot: project,
        artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
        artifactContent,
        prompt: "review exact artifact",
        approvalScope: "workspace-read",
        idempotencyKey: "review-application",
      });

      await expect(service.reviewStatus({ reviewId: result.reviewId })).resolves.toMatchObject({
        review: { reviewId: result.reviewId, artifactHash: createHash("sha256").update(artifactContent).digest("hex") },
        barrier: { satisfied: false, requiredCount: 2 },
      });
      await expect(service.status()).resolves.toMatchObject({
        queue: { queued: 6, claimed: 0, completed: 0, failed: 0, cancelled: 0, needs_reconciliation: 0 },
      });
      expect(reviewRuns.list()).toHaveLength(6);
      expect(allRuns.list()).toHaveLength(8);
    } finally {
      providers.close();
      reviews.close();
      reviewRuns.close();
      allRuns.close();
    }
  });

  it("keeps requester, scope, hash, redaction, and workspace validation at the application boundary", async () => {
    const { project, allRuns, reviewRuns, reviews, providers, service } = fixture();
    const artifactContent = "review boundary";
    const input = {
      requester: "codex" as const,
      workspaceRoot: project,
      artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
      artifactContent,
      prompt: "review",
      approvalScope: "workspace-read" as const,
      idempotencyKey: "review-boundary",
    };
    try {
      await expect(service.requestReview({ ...input, requester: "grok" }))
        .rejects.toThrow(/only Codex may mint a review grant/i);
      await expect(service.requestReview({ ...input, approvalScope: "external" }))
        .rejects.toThrow(/immutable read-only/i);
      await expect(service.requestReview({ ...input, artifactHash: "0".repeat(64) }))
        .rejects.toThrow(/artifact hash mismatch/i);
      await expect(service.requestReview({ ...input, artifactContent: "token=secret-value" }))
        .rejects.toThrow(/credential material/i);
      await expect(service.requestReview({ ...input, workspaceRoot: join(project, "missing") }))
        .rejects.toThrow(/real project directory/i);
      expect(allRuns.list()).toEqual([]);
    } finally {
      providers.close();
      reviews.close();
      reviewRuns.close();
      allRuns.close();
    }
  });

  it.each(["divergent_pair", "capture_failure"] as const)(
    "persists optional %s admission as recovery-eligible provider state",
    async (failure) => {
      const context = fixture({
        source: (input, fingerprint) => {
          if (input.agent !== "grok" || input.role !== "critic") {
            return { sourceFingerprint: fingerprint, valid: true };
          }
          if (failure === "capture_failure") throw new Error("temporary evidence read failure");
          return { sourceFingerprint: `${fingerprint}-divergent`, valid: true };
        },
      });
      const { project, allRuns, reviewRuns, reviews, providers, service } = context;
      const artifactContent = `recovery eligible ${failure}`;
      try {
        const result = await service.requestReview({
          requester: "codex",
          workspaceRoot: project,
          artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
          artifactContent,
          prompt: "review",
          approvalScope: "workspace-read",
          idempotencyKey: failure,
        });

        expect(providers.get("grok")).toMatchObject({
          health: "unavailable",
          capabilityVerified: false,
          attemptClaimed: false,
          retryAt: 60_100,
        });
        expect(reviews.get(result.reviewId)?.lanes.filter((lane) => lane.agent === "grok")
          .map((lane) => lane.status)).toEqual(["deferred", "deferred"]);
        expect(result).toMatchObject({ activeLaneCount: 4, runState: "DEGRADED_REVIEW_SET" });

        const probe = vi.fn(async () => ({ ready: true as const }));
        const recoveryCapture = new ReviewEvidenceCapture({
          captureSource: ({ project: workspace }) => ({
            sourceFingerprint: captureWorkspaceFingerprint(workspace).fingerprint,
            valid: true,
          }),
          captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
          observedAt: () => 60_101,
        });
        await expect(runAutomaticProviderRecovery({
          now: 60_100,
          health: providers,
          reviews,
          evidenceCapture: recoveryCapture,
          agents: ["grok"],
          probe,
        })).resolves.toMatchObject([{ status: "recovered", generation: 1,
          rejoin: { activated: 2 } }]);
        expect(probe).toHaveBeenCalledOnce();
        expect(providers.get("grok")).toMatchObject({ health: "healthy", capabilityVerified: true });
        expect(reviews.get(result.reviewId)?.lanes.filter((lane) => lane.agent === "grok")
          .map((lane) => lane.status)).toEqual(["queued", "queued"]);
      } finally {
        providers.close();
        reviews.close();
        reviewRuns.close();
        allRuns.close();
      }
    },
  );
});
