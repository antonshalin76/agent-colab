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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-codex-demand-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const databasePath = join(root, "state.db");
  initializeCurrentExecutionSchema(databasePath);
  return { root, project, databasePath };
}

function evidence(project: string, unavailableCodex = false, observedAt = 100) {
  return new ReviewEvidenceCapture({
    captureSource: () => ({
      sourceFingerprint: captureWorkspaceFingerprint(project).fingerprint,
      valid: true,
    }),
    captureReadiness: ({ agent }: ReviewEvidenceCaptureInput) =>
      unavailableCodex && agent === "codex"
        ? { harnessReady: false, state: "provider_unavailable", valid: false }
        : { harnessReady: true, state: "ready", valid: true },
    observedAt: () => observedAt,
  });
}

function request(project: string, key: string) {
  const artifactContent = `durable Codex demand ${key}`;
  return {
    requester: "codex" as const,
    workspaceRoot: project,
    artifactHash: createHash("sha256").update(artifactContent).digest("hex"),
    artifactContent,
    prompt: "run isolated auditor and critic",
    approvalScope: "workspace-read" as const,
    idempotencyKey: key,
  };
}

function openApplication(context: ReturnType<typeof fixture>, capture: ReviewEvidenceCapture) {
  const runs = new RunStore(context.databasePath, { scope: "review" });
  const reviews = new RunGateUnitOfWork(context.databasePath);
  const providers = new ProviderHealthStore(context.databasePath, { cooldownMs: 60_000 });
  const service = new ReviewApplicationService({
    runs,
    reviews,
    providers,
    projects: new ProjectPolicy([context.root]),
    evidenceCapture: capture,
  });
  return {
    service,
    runs,
    reviews,
    providers,
    close() {
      providers.close();
      reviews.close();
      runs.close();
    },
  };
}

describe("durable Codex demand and automatic recovery", () => {
  it("persists fresh probing demand and activates the Codex pair once after restart and a fresh probe", async () => {
    const context = fixture();
    const initial = openApplication(context, evidence(context.project));
    const created = await initial.service.requestReview(request(context.project, "fresh-probing"));
    expect(created).toMatchObject({ activeLaneCount: 0, runState: "DEGRADED_REVIEW_SET" });
    expect(initial.reviews.get(created.reviewId)?.lanes.filter(({ agent }) => agent === "codex")
      .map(({ status }) => status)).toEqual(["deferred", "deferred"]);
    expect(initial.runs.list()).toEqual([]);
    initial.close();

    const health = new ProviderHealthStore(context.databasePath, { cooldownMs: 60_000 });
    const reviews = new RunGateUnitOfWork(context.databasePath);
    const runs = new RunStore(context.databasePath, { scope: "review" });
    const probe = vi.fn(async () => ({ ready: true as const }));
    try {
      await expect(runAutomaticProviderRecovery({
        now: 101,
        health,
        reviews,
        evidenceCapture: evidence(context.project, false, 101),
        agents: ["codex"],
        probe,
      })).resolves.toMatchObject([{ agent: "codex", status: "recovered", generation: 1,
        rejoin: { activated: 2 } }]);
      expect(probe).toHaveBeenCalledOnce();
      expect(reviews.get(created.reviewId)?.lanes.filter(({ agent }) => agent === "codex")
        .map(({ status }) => status)).toEqual(["queued", "queued"]);
      expect(runs.list()).toHaveLength(2);

      await runAutomaticProviderRecovery({
        now: 102,
        health,
        reviews,
        evidenceCapture: evidence(context.project, false, 102),
        agents: ["codex"],
        probe,
      });
      expect(probe).toHaveBeenCalledOnce();
      expect(runs.list()).toHaveLength(2);
    } finally {
      runs.close();
      reviews.close();
      health.close();
    }
  });

  it("keeps exact Codex unavailability as deferred demand until cooldown recovery", async () => {
    const context = fixture();
    const initial = openApplication(context, evidence(context.project, true));
    try {
      const created = await initial.service.requestReview(request(context.project, "initial-unavailable"));
      expect(created).toMatchObject({ activeLaneCount: 0, runState: "DEGRADED_REVIEW_SET" });
      expect(initial.providers.get("codex")).toMatchObject({
        health: "unavailable",
        capabilityVerified: false,
        retryAt: 60_100,
      });
      expect(initial.reviews.get(created.reviewId)?.lanes.filter(({ agent }) => agent === "codex")
        .map(({ status }) => status)).toEqual(["deferred", "deferred"]);

      const probe = vi.fn(async () => ({ ready: true as const }));
      const beforeDue = initial.providers.snapshot();
      await expect(runAutomaticProviderRecovery({
        now: 60_099,
        health: initial.providers,
        reviews: initial.reviews,
        evidenceCapture: evidence(context.project, false, 60_099),
        agents: ["codex"],
        probe,
      })).resolves.toMatchObject([{ status: "not_due" }]);
      expect(probe).not.toHaveBeenCalled();
      expect(initial.providers.snapshot()).toEqual(beforeDue);

      await expect(runAutomaticProviderRecovery({
        now: 60_100,
        health: initial.providers,
        reviews: initial.reviews,
        evidenceCapture: evidence(context.project, false, 60_100),
        agents: ["codex"],
        probe,
      })).resolves.toMatchObject([{ status: "recovered", generation: 1,
        rejoin: { activated: 2 } }]);
      expect(probe).toHaveBeenCalledOnce();
      expect(initial.runs.list()).toHaveLength(2);
    } finally {
      initial.close();
    }
  });
});
