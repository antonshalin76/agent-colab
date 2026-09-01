import { describe, expect, it, vi } from "vitest";

import type { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import type { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import { activateRecoveredReviewLanes } from "../src/runtime/review-rejoin.js";
import type { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";

const readyCapture = (agent: "grok" | "claude") => ({
  capture: vi.fn((input: { project: string }) => ({
    kind: "ready" as const,
    agent,
    observedAt: 101,
    source: { sourceFingerprint: `${input.project}-fingerprint`, valid: true },
    readiness: { harnessReady: true, state: "ready" as const, valid: true },
  })),
}) as unknown as ReviewEvidenceCapture;

const health = (generation = 1) => ({
  latestRecoveryGeneration: vi.fn(() => generation),
  applyCaptureOutcome: vi.fn(),
}) as unknown as ProviderHealthStore;

describe("optional review rejoin scheduling", () => {
  it("does not reopen a review after the required Codex barrier is satisfied", () => {
    const evidenceCapture = readyCapture("grok");
    const activateDeferred = vi.fn();
    const reviews = {
      deferredReviewIds: () => ["closed-review"],
      get: () => ({ project: "/closed", lanes: [] }),
      barrier: () => ({ satisfied: true, terminalCount: 2, requiredCount: 2 }),
      activateDeferred,
    } as unknown as RunGateUnitOfWork;

    expect(activateRecoveredReviewLanes({ agent: "grok", now: 101, reviews,
      health: health(), evidenceCapture })).toEqual({ activated: 0, stale: 0,
      skippedUnreadableProject: 0, skippedSatisfied: 1, skippedHarnessUnavailable: 0 });
    expect(evidenceCapture.capture).not.toHaveBeenCalled();
    expect(activateDeferred).not.toHaveBeenCalled();
  });

  it("skips an unreadable optional project and continues admitting current work", () => {
    const evidenceCapture = readyCapture("grok");
    const activateDeferred = vi.fn(() => ({ status: "activated", lanes: [{}, {}] }));
    const reviews = {
      deferredReviewIds: () => ["bad-review", "good-review"],
      get: (reviewId: string) => reviewId === "bad-review"
        ? { project: null, lanes: [
          { agent: "grok", role: "auditor", status: "deferred" },
          { agent: "grok", role: "critic", status: "deferred" },
        ] }
        : { project: "/good", lanes: [
          { agent: "grok", role: "auditor", status: "deferred" },
          { agent: "grok", role: "critic", status: "deferred" },
        ] },
      barrier: () => ({ satisfied: false, terminalCount: 0, requiredCount: 2 }),
      receiptPairCursor: () => ({ scopeRevision: 1,
        predecessorReceiptIds: { source: null, readiness: null } }),
      admissionTuple: () => ({ laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null }),
      captureReviewReceiptPair: () => ({ lifecycle: "pending" }),
      activateDeferred,
    } as unknown as RunGateUnitOfWork;

    expect(activateRecoveredReviewLanes({ agent: "grok", now: 101, reviews,
      health: health(), evidenceCapture })).toMatchObject({ activated: 2,
      skippedUnreadableProject: 1, skippedHarnessUnavailable: 0 });
    expect(activateDeferred).toHaveBeenCalledOnce();
    const activationCall = activateDeferred.mock.lastCall as unknown as
      [{ admissionReceipts: unknown[] }];
    expect(activationCall[0].admissionReceipts).toHaveLength(2);
  });

  it("keeps deferred work dormant when typed evidence reports provider unavailable", () => {
    const evidenceCapture = { capture: vi.fn(() => ({ kind: "provider_unavailable" as const,
      agent: "claude" as const, observedAt: 101,
      source: { sourceFingerprint: "source-v1", valid: true },
      readiness: { harnessReady: false, state: "provider_unavailable" as const, valid: false },
    })) } as unknown as ReviewEvidenceCapture;
    const activateDeferred = vi.fn();
    const reviews = {
      deferredReviewIds: () => ["pending-review"],
      get: () => ({ project: "/pending",
        lanes: [
          { agent: "claude", role: "auditor", status: "deferred" },
          { agent: "claude", role: "critic", status: "deferred" },
        ] }),
      barrier: () => ({ satisfied: false, terminalCount: 0, requiredCount: 2 }),
      activateDeferred,
    } as unknown as RunGateUnitOfWork;

    expect(activateRecoveredReviewLanes({ agent: "claude", now: 101, reviews,
      health: health(), evidenceCapture })).toMatchObject({ activated: 0,
      skippedHarnessUnavailable: 2 });
    expect(activateDeferred).not.toHaveBeenCalled();
  });

  it("rejects caller-owned raw readiness instead of bypassing typed capture", () => {
    const reviews = { deferredReviewIds: () => [] } as unknown as RunGateUnitOfWork;
    expect(() => activateRecoveredReviewLanes({ agent: "claude", now: 101, reviews,
      health: health(), harnessReady: true } as never)).toThrow(/legacy raw rejoin evidence/i);
  });
});
