import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { runAutomaticProviderRecovery } from "../src/runtime/provider-recovery-loop.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const database = (): string => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-auto-recovery-"));
  roots.push(root);
  const path = join(root, "state.db");
  initializeCurrentExecutionSchema(path);
  return path;
};

const evidenceCapture = new ReviewEvidenceCapture({
  captureSource: () => ({ sourceFingerprint: "source-v1", valid: true }),
  captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
  observedAt: () => 10,
});

const deferredReviews = () => {
  let deferred = true;
  const reviews = {
    deferredReviewIds: vi.fn(() => deferred ? ["review-1"] : []),
    get: vi.fn(() => ({ project: "/repo", lanes: [
      { agent: "claude", role: "auditor", status: "deferred" },
      { agent: "claude", role: "critic", status: "deferred" },
    ] })),
    barrier: vi.fn(() => ({ satisfied: false })),
    receiptPairCursor: vi.fn(() => ({ scopeRevision: 1,
      predecessorReceiptIds: { source: null, readiness: null } })),
    admissionTuple: vi.fn(() => ({ laneRevision: 0, latestOrdinal: null,
      latestEvidenceHash: null })),
    captureReviewReceiptPair: vi.fn(() => ({ lifecycle: "pending" })),
    activateDeferred: vi.fn(() => {
      deferred = false;
      return { status: "activated", lanes: [{}, {}] };
    }),
    hasUnconsumedRecoveryGeneration: vi.fn(() => deferred),
  };
  return reviews;
};

const recoveryDemand = (...agents: Array<"grok" | "claude" | "codex">) => {
  const demanded = new Set(agents);
  return {
    deferredReviewIds: vi.fn((agent: "grok" | "claude" | "codex") =>
      demanded.has(agent) ? [`${agent}-review`] : []),
    get: vi.fn((reviewId: string) => {
      const agent = reviewId.replace("-review", "") as "grok" | "claude" | "codex";
      return { project: "/repo", lanes: [
        { agent, role: "auditor", status: "deferred" },
        { agent, role: "critic", status: "deferred" },
      ] };
    }),
    barrier: vi.fn(() => ({ satisfied: false })),
    receiptPairCursor: vi.fn(() => ({ scopeRevision: 1,
      predecessorReceiptIds: { source: null, readiness: null } })),
    admissionTuple: vi.fn(() => ({ laneRevision: 0, latestOrdinal: null,
      latestEvidenceHash: null })),
    captureReviewReceiptPair: vi.fn(() => ({ lifecycle: "pending" })),
    activateDeferred: vi.fn((input: { agent: "grok" | "claude" | "codex" }) => {
      demanded.delete(input.agent);
      return { status: "activated", lanes: [{}, {}] };
    }),
    hasUnconsumedRecoveryGeneration: vi.fn((agent: "grok" | "claude" | "codex") =>
      demanded.has(agent)),
  };
};

describe("automatic provider recovery loop", () => {
  it("recovers each harness independently and never reprobes a healthy harness", async () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = recoveryDemand("grok", "claude");
    const probe = vi.fn(async (agent: "grok" | "claude" | "codex") => agent === "grok"
      ? { ready: true }
      : { ready: false, failure: { kind: "quota" as const } });

    const first = await runAutomaticProviderRecovery({ now: 10, health,
      reviews: reviews as never, evidenceCapture, probe, agents: ["grok", "claude"] });
    expect(first).toEqual([
      { agent: "grok", status: "recovered", generation: 1,
        rejoin: { activated: 2, stale: 0, skippedUnreadableProject: 0,
          skippedSatisfied: 0, skippedHarnessUnavailable: 0 } },
      { agent: "claude", status: "unavailable", generation: 0 },
    ]);
    expect(health.get("grok").health).toBe("healthy");
    expect(health.get("claude")).toMatchObject({ health: "unavailable", retryAt: 1_010 });

    const second = await runAutomaticProviderRecovery({ now: 11, health,
      reviews: reviews as never, evidenceCapture, probe, agents: ["grok", "claude"] });
    expect(second.map(({ status }) => status)).toEqual(["not_due", "not_due"]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(health.latestRecoveryGeneration("grok")).toBe(1);
    health.close();
  });

  it("resumes a due failed harness after restart with exactly one new generation", async () => {
    const path = database();
    const first = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = recoveryDemand("claude");
    await runAutomaticProviderRecovery({ now: 10, health: first, reviews: reviews as never,
      evidenceCapture, agents: ["claude"], probe: async () => ({ ready: false,
        failure: { kind: "network_timeout" } }) });
    first.close();

    const reopened = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const recovered = await runAutomaticProviderRecovery({ now: 1_010, health: reopened,
      reviews: reviews as never, evidenceCapture, agents: ["claude"],
      probe: async () => ({ ready: true }) });
    expect(recovered).toEqual([{ agent: "claude", status: "recovered", generation: 1,
      rejoin: { activated: 2, stale: 0, skippedUnreadableProject: 0,
        skippedSatisfied: 0, skippedHarnessUnavailable: 0 } }]);
    expect(reopened.latestRecoveryGeneration("claude")).toBe(1);
    reopened.close();
  });

  it("drains a committed recovery generation after a crash before rejoin", async () => {
    const path = database();
    const beforeCrash = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(beforeCrash.acquireRecoveryProbeAdmission("claude", 10))
      .toEqual({ runnable: true, claimedAt: 10 });
    beforeCrash.recordSuccess("claude", 11, 10);
    beforeCrash.close();

    const afterRestart = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = deferredReviews();
    const probe = vi.fn(async () => ({ ready: true }));
    const first = await runAutomaticProviderRecovery({ now: 12, health: afterRestart,
      reviews: reviews as never, evidenceCapture, agents: ["claude"], probe });
    expect(first).toEqual([{ agent: "claude", status: "rejoined", generation: 1,
      rejoin: { activated: 2, stale: 0, skippedUnreadableProject: 0,
        skippedSatisfied: 0, skippedHarnessUnavailable: 0 } }]);
    expect(reviews.activateDeferred).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();

    const replay = await runAutomaticProviderRecovery({ now: 13, health: afterRestart,
      reviews: reviews as never, evidenceCapture, agents: ["claude"], probe });
    expect(replay).toEqual([{ agent: "claude", status: "not_due", generation: 1 }]);
    expect(reviews.activateDeferred).toHaveBeenCalledTimes(1);
    afterRestart.close();
  });

  it("mints a fresh generation for healthy provider state with durable deferred demand", async () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("grok", 1);
    const reviews = recoveryDemand("grok");
    const probe = vi.fn(async () => ({ ready: true as const }));

    const result = await runAutomaticProviderRecovery({
      now: 10,
      health,
      reviews: reviews as never,
      evidenceCapture,
      agents: ["grok"],
      probe,
    });

    expect(result).toMatchObject([{ status: "recovered", generation: 1,
      rejoin: { activated: 2 } }]);
    expect(probe).toHaveBeenCalledOnce();
    expect(health.latestRecoveryGeneration("grok")).toBe(1);
    health.close();
  });

  it("retries rejoin after transient evidence-capture infrastructure failure", async () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    expect(health.acquireRecoveryProbeAdmission("claude", 10))
      .toEqual({ runnable: true, claimedAt: 10 });
    health.recordSuccess("claude", 11, 10);
    const reviews = deferredReviews();
    let captureReady = false;
    const capture = new ReviewEvidenceCapture({
      captureSource: () => captureReady
        ? { sourceFingerprint: "source-v1", valid: true }
        : (() => { throw new Error("temporary source read failure"); })(),
      captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
      observedAt: () => 12,
    });
    const probe = vi.fn(async () => ({ ready: true }));
    const first = await runAutomaticProviderRecovery({ now: 12, health,
      reviews: reviews as never, evidenceCapture: capture, agents: ["claude"], probe });
    expect(first[0]).toMatchObject({ status: "unavailable", generation: 1,
      rejoin: { activated: 0, skippedHarnessUnavailable: 0 } });
    expect(reviews.activateDeferred).not.toHaveBeenCalled();
    expect(health.get("claude")).toMatchObject({ health: "unavailable", retryAt: 1_012 });

    captureReady = true;
    const second = await runAutomaticProviderRecovery({ now: 13, health,
      reviews: reviews as never, evidenceCapture: capture, agents: ["claude"], probe });
    expect(second[0]).toMatchObject({ status: "not_due", generation: 1 });
    const third = await runAutomaticProviderRecovery({ now: 1_012, health,
      reviews: reviews as never, evidenceCapture: capture, agents: ["claude"], probe });
    expect(third[0]).toMatchObject({ status: "recovered", generation: 2,
      rejoin: { activated: 2 } });
    expect(reviews.activateDeferred).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledOnce();
    health.close();
  });

  it("does not probe or mutate provider state when no deferred barrier demands recovery", async () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const before = health.snapshot();
    const probe = vi.fn(async () => ({ ready: true as const }));

    const result = await runAutomaticProviderRecovery({
      now: 10,
      health,
      reviews: { deferredReviewIds: vi.fn(() => []) } as never,
      evidenceCapture,
      agents: ["grok", "claude", "codex"],
      probe,
    });

    expect(result.map(({ status }) => status)).toEqual(["not_due", "not_due", "not_due"]);
    expect(probe).not.toHaveBeenCalled();
    expect(health.snapshot()).toEqual(before);
    health.close();
  });

  it("releases the durable probe claim instead of recording provider failure on worker shutdown", async () => {
    const path = database();
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    const reviews = recoveryDemand("claude");
    const controller = new AbortController();
    const probe = vi.fn((_agent: "grok" | "claude" | "codex", signal?: AbortSignal) =>
      new Promise<{ ready: true }>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const recovering = runAutomaticProviderRecovery({
      now: 10,
      health,
      reviews: reviews as never,
      evidenceCapture,
      agents: ["claude"],
      probe,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());

    controller.abort(new Error("worker shutdown"));

    await expect(recovering).rejects.toThrow("worker shutdown");
    expect(health.get("claude")).toMatchObject({
      health: "probing",
      attemptClaimed: false,
      failureCount: 0,
    });
    health.close();
  });
});
