import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import { executeReviewLaunchWithFence } from "../src/runtime/review-launch-admission.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("review launch JIT admission", () => {
  it("does not spawn when provider health changes after queue claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-jit-review-"));
    roots.push(root);
    const path = join(root, "state.db");
    initializeCurrentExecutionSchema(path);
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 1);
    const gate = new RunGateUnitOfWork(path);
    const admissionReceipts = (["auditor", "critic"] as const).map((role) => {
      const activationNonce = `jit-review/codex/${role}`;
      const sourceReceiptId = `${activationNonce}/source`;
      const readinessReceiptId = `${activationNonce}/readiness`;
      gate.captureReviewReceiptPair({ pairId: activationNonce, phase: "admission",
        activationNonce, scopeRevision: 1, recoveryGeneration: null,
        expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
        predecessorReceiptIds: { source: null, readiness: null }, receipts: {
          source: { receiptId: sourceReceiptId, scope: `review/jit-review/codex/${role}/source`,
            observation: { sourceFingerprint: "source-v1", valid: true } },
          readiness: { receiptId: readinessReceiptId,
            scope: `review/jit-review/codex/${role}/readiness`,
            observation: { harnessReady: true, state: "ready", valid: true } },
        }, createdAt: 1 });
      return { agent: "codex" as const, role, activationNonce, sourceReceiptId, readinessReceiptId };
    });
    gate.create({
      reviewId: "jit-review",
      stageId: "architecture-audit",
      artifact: Buffer.from("jit"),
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
      approvalScope: "workspace-read",
      idempotencyKey: "jit-review",
      prompts: { auditor: "audit", critic: "critic" },
      requester: "codex",
      project: process.cwd(),
      sourceFingerprint: "source-v1",
      createdAt: 1,
      admissionReceipts,
    });
    const runs = new RunStore(path);
    const claimed = runs.claimNext({ workerId: "jit", leaseMs: 1_000,
      now: Date.now() + 1_000 })!;
    health.recordFailoverFailure("codex", { kind: "model_unavailable" }, 2);
    const launch = vi.fn(async () => ({ kind: "success" }));
    const unavailable = { kind: "provider_unavailable" as const, agent: "codex" as const,
      observedAt: 3, source: { sourceFingerprint: "source-v1", valid: true },
      readiness: { harnessReady: false, state: "provider_unavailable" as const, valid: false } };
    const evidenceCapture = new ReviewEvidenceCapture({
      captureSource: () => unavailable.source,
      captureReadiness: () => unavailable.readiness,
      observedAt: () => unavailable.observedAt,
    });

    const result = await executeReviewLaunchWithFence({
      run: claimed,
      health,
      observedAt: 3,
      evidenceCapture,
      reviews: gate,
      launch,
    });

    expect(launch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "rejected",
      providerResult: unavailable,
      prelaunchFence: { status: "no_spawn", reason: "provider_unavailable" },
    });
    const replay = await executeReviewLaunchWithFence({
      run: claimed, health, observedAt: 4, evidenceCapture, reviews: gate, launch,
    });
    expect(replay).toMatchObject({ status: "rejected",
      prelaunchFence: { status: "no_spawn", reason: "provider_unavailable" } });
    const proof = new Database(path, { readonly: true });
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_no_spawn_effects
      WHERE attempt_id=?`).pluck().get(claimed.payload?.reviewAttemptId)).toBe(1);
    expect(proof.prepare(`SELECT COUNT(*) FROM runtime_review_spawn_authorities
      WHERE attempt_id=?`).pluck().get(claimed.payload?.reviewAttemptId)).toBe(0);
    proof.close();

    runs.close();
    gate.close();
    health.close();
  });
});
