import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/store/run-store.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import {
  RunGateUnitOfWork,
  type ReviewAdmissionReceiptPair,
} from "../src/runtime/run-gate-unit-of-work.js";
import { CollaborationRunStore } from "../src/store/collaboration-run-store.js";
import Database from "better-sqlite3";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";

const roots: string[] = [];
const makeDb = () => { const root = mkdtempSync(join(tmpdir(), "agent-collab-store-")); roots.push(root);
  const path = join(root, "state.db"); initializeCurrentExecutionSchema(path); return path; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const createReview = (gate: RunGateUnitOfWork,
  input: Parameters<RunGateUnitOfWork["create"]>[0]) => {
  const admissionReceipts: ReviewAdmissionReceiptPair[] = [];
  for (const agent of ["grok", "claude", "codex"] as const) {
    if (input.health[agent] !== "healthy") continue;
    for (const role of ["auditor", "critic"] as const) {
      const activationNonce = `store/${input.reviewId}/${agent}/${role}`;
      const sourceReceiptId = `${activationNonce}/source`;
      const readinessReceiptId = `${activationNonce}/readiness`;
      gate.captureReviewReceiptPair({ pairId: activationNonce, phase: "admission",
        activationNonce, scopeRevision: 1, recoveryGeneration: null,
        expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
        predecessorReceiptIds: { source: null, readiness: null }, receipts: {
          source: { receiptId: sourceReceiptId,
            scope: `review/${input.reviewId}/${agent}/${role}/source`,
            observation: { sourceFingerprint: input.sourceFingerprint ?? "source-v1", valid: true } },
          readiness: { receiptId: readinessReceiptId,
            scope: `review/${input.reviewId}/${agent}/${role}/readiness`,
            observation: { harnessReady: true, valid: true } },
        }, createdAt: input.createdAt });
      admissionReceipts.push({ agent, role, activationNonce, sourceReceiptId, readinessReceiptId });
    }
  }
  return gate.create({ ...input, admissionReceipts });
};

describe("durable run store", () => {
  it.each([
    ["probing", 0, 0],
    ["unavailable", 1, 0],
    ["disabled", 0, 0],
    ["healthy-unverified", 0, 0],
    ["healthy-probe-claimed", 1, 1],
  ] as const)("leaves provider health classification to the prelaunch fence when state is %s",
    (state, capabilityVerified, attemptClaimed) => {
      const path = makeDb();
      const gate = new RunGateUnitOfWork(path);
      createReview(gate, {
        reviewId: `health-${state}`,
        stageId: "architecture-audit",
        artifact: Buffer.from(state),
        health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
        approvalScope: "workspace-read",
        idempotencyKey: `health-${state}`,
        prompts: { auditor: "audit", critic: "critic" },
        requester: "codex",
        project: process.cwd(),
        sourceFingerprint: "source-v1",
        createdAt: 1,
      });
      const db = new Database(path);
      const health = state.startsWith("healthy") ? "healthy" : state;
      db.prepare(`UPDATE runtime_provider_health
        SET health=?, capability_verified=?, attempt_claimed=?, updated_at=10
        WHERE agent='codex'`).run(health, capabilityVerified, attemptClaimed);
      db.close();
      const runs = new RunStore(path);

      expect(runs.claimNext({ workerId: "health-fence", leaseMs: 100,
        now: Date.now() + 1_000 })).toMatchObject({
        stage: "review:auditor", payload: { reviewId: `health-${state}` },
      });

      runs.close();
      gate.close();
    });

  it("claims only a linked one-shot review attempt for a healthy verified provider", () => {
    const path = makeDb();
    const gate = new RunGateUnitOfWork(path);
    createReview(gate, {
      reviewId: "linked-authority",
      stageId: "architecture-audit",
      artifact: Buffer.from("linked"),
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
      approvalScope: "workspace-read",
      idempotencyKey: "linked-authority",
      prompts: { auditor: "audit", critic: "critic" },
      requester: "codex",
      project: process.cwd(),
      sourceFingerprint: "source-v1",
      createdAt: 1,
    });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 2);
    const runs = new RunStore(path);
    const forged = runs.enqueue({
      idempotencyKey: "forged-review",
      stage: "review:auditor",
      priority: 0,
      now: 2,
      payload: { decision: { agent: "codex" } },
    });

    const first = runs.claimNext({ workerId: "linked-1", leaseMs: 100, now: Date.now() + 1_000 });
    const second = runs.claimNext({ workerId: "linked-2", leaseMs: 100, now: Date.now() + 1_000 });
    expect([first, second].map((run) => run?.payload?.reviewId)).toEqual([
      "linked-authority",
      "linked-authority",
    ]);
    expect(runs.claimNext({ workerId: "linked-3", leaseMs: 100,
      now: Date.now() + 1_000 })).toBeUndefined();
    expect(runs.get(forged.id)?.status).toBe("queued");

    runs.close();
    health.close();
    gate.close();
  });

  it("rejects generic cancellation of a linked review attempt without splitting lane state", () => {
    const path = makeDb();
    const gate = new RunGateUnitOfWork(path);
    const review = createReview(gate, {
      reviewId: "cancel-fence",
      stageId: "architecture-audit",
      artifact: Buffer.from("cancel"),
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
      approvalScope: "workspace-read",
      idempotencyKey: "cancel-fence",
      prompts: { auditor: "audit", critic: "critic" },
      requester: "codex",
      project: process.cwd(),
      sourceFingerprint: "source-v1",
      createdAt: 1,
    });
    const runs = new RunStore(path);
    const runId = runs.getByIdempotencyKey(
      review.lanes.find((lane) => lane.agent === "codex" && lane.role === "auditor")!.idempotencyKey,
    )!.id;

    expect(() => runs.cancel(runId, "operator")).toThrow(/linked review attempt/i);
    expect(runs.get(runId)?.status).toBe("queued");
    expect(gate.get("cancel-fence")?.lanes.find(
      (lane) => lane.agent === "codex" && lane.role === "auditor",
    )?.status).toBe("queued");

    runs.close();
    gate.close();
  });

  it("does not requeue a consumed review grant after its prelaunch lease expires", () => {
    const path = makeDb();
    const gate = new RunGateUnitOfWork(path);
    createReview(gate, {
      reviewId: "expired-grant",
      stageId: "architecture-audit",
      artifact: Buffer.from("expired"),
      health: { grok: "unavailable", claude: "unavailable", codex: "healthy" },
      approvalScope: "workspace-read",
      idempotencyKey: "expired-grant",
      prompts: { auditor: "audit", critic: "critic" },
      requester: "codex",
      project: process.cwd(),
      sourceFingerprint: "source-v1",
      createdAt: 1,
    });
    const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
    health.recordSuccess("codex", 2);
    const runs = new RunStore(path);
    const claimed = runs.claimNext({ workerId: "expired", leaseMs: 10,
      now: Date.now() + 1_000 })!;

    expect(runs.recoverExpired(claimed.leaseExpiresAt! + 1)).toBe(1);
    expect(runs.get(claimed.id)?.status).toBe("needs_reconciliation");
    expect(runs.claimNext({ workerId: "replacement", leaseMs: 10,
      now: claimed.leaseExpiresAt! + 2 })?.id).not.toBe(claimed.id);

    runs.close();
    health.close();
    gate.close();
  });
  it.each([
    ["run", (path: string) => new RunStore(path)],
    ["gate", (path: string) => new RunGateUnitOfWork(path)],
    ["workflow", (path: string) => new CollaborationRunStore(path)],
  ] as const)("keeps the %s runtime constructor DDL-free on a blank database", (_name, open) => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-ddl-owner-"));
    roots.push(root);
    const path = join(root, "state.db");
    expect(() => open(path)).toThrow(/migration-owned schema|current migration-owned schema/i);
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    db.close();
  });

  it("deduplicates idempotency keys and preserves original immutable fields", () => {
    const store = new RunStore(makeDb());
    const first = store.enqueue({ idempotencyKey: "same", stage: "planning", priority: 10, artifactHash: "a", approvalScope: "workspace-read" });
    const second = store.enqueue({ idempotencyKey: "same", stage: "review", priority: 1, artifactHash: "different", approvalScope: "external" });
    expect(second).toEqual(first);
    expect(store.list()).toHaveLength(1);
    store.close();
  });

  it("uses priority then FIFO and honors queued cancellation", () => {
    const store = new RunStore(makeDb());
    const low = store.enqueue({ idempotencyKey: "low", stage: "review", priority: 20, now: 1 });
    const firstHigh = store.enqueue({ idempotencyKey: "first-high", stage: "review", priority: 1, now: 2 });
    const cancelled = store.enqueue({ idempotencyKey: "cancel", stage: "review", priority: 0, now: 3 });
    const secondHigh = store.enqueue({ idempotencyKey: "second-high", stage: "review", priority: 1, now: 4 });
    store.cancel(cancelled.id, "user");
    const claimedFirst = store.claimNext({ workerId: "w", leaseMs: 100, now: 10 })!;
    expect(claimedFirst.id).toBe(firstHigh.id);
    store.releaseForRetry(firstHigh.id, claimedFirst.leaseToken!, { nextAttemptAt: 50 });
    expect(store.claimNext({ workerId: "w", leaseMs: 100, now: 11 })?.id).toBe(secondHigh.id);
    expect(store.get(cancelled.id)?.status).toBe("cancelled");
    expect(store.get(low.id)?.status).toBe("queued");
    store.close();
  });

  it("does not claim unlinked review stages regardless of payload hints", () => {
    const store = new RunStore(makeDb());
    const ordinary = store.enqueue({ idempotencyKey: "ordinary", stage: "review:critic", priority: 5, now: 1,
      payload: { providerAdmissionClaimedAt: "invalid" } });
    const demanded = store.enqueue({ idempotencyKey: "demanded", stage: "review:auditor", priority: 5, now: 2,
      payload: { providerAdmissionClaimedAt: 42 } });
    const coordination = store.enqueue({ idempotencyKey: "coordination-first", stage: "coordination", priority: 1, now: 3 });
    expect(store.claimNext({ workerId: "w", leaseMs: 100, now: 10 })?.id).toBe(coordination.id);
    expect(store.claimNext({ workerId: "w", leaseMs: 100, now: 11 })).toBeUndefined();
    expect(store.get(ordinary.id)?.status).toBe("queued");
    expect(store.get(demanded.id)?.status).toBe("queued");
    store.close();
  });

  it("fences two store connections and rejects stale lease completion", () => {
    const path = makeDb(); const first = new RunStore(path); const second = new RunStore(path);
    first.enqueue({ idempotencyKey: "one-launch", stage: "review", priority: 5, now: 1 });
    const a = first.claimNext({ workerId: "a", leaseMs: 30_000, now: 10 });
    const b = second.claimNext({ workerId: "b", leaseMs: 30_000, now: 10 });
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(() => first.complete(a!.id, "stale-token", { text: "wrong" })).toThrow(/lease/i);
    first.complete(a!.id, a!.leaseToken!, { text: "ok" });
    expect(second.get(a!.id)?.status).toBe("completed");
    first.close(); second.close();
  });

  it("recovers each crash window without a blind duplicate launch", () => {
    const path = makeDb(); let store = new RunStore(path);
    const beforeId = store.enqueue({ idempotencyKey: "before", stage: "planning", priority: 1, now: 1 }).id;
    store.claimNext({ workerId: "a", leaseMs: 1, now: 10 }); store.close(); store = new RunStore(path);
    store.recoverExpired(20); expect(store.get(beforeId)?.status).toBe("queued");
    const afterId = store.enqueue({ idempotencyKey: "after", stage: "coding", priority: 1, now: 21 }).id;
    const after = store.claimNext({ workerId: "a", leaseMs: 1, now: 30 })!;
    store.markLaunchIntent(after.id, after.leaseToken!, { agent: "codex" });
    store.markLaunched(after.id, after.leaseToken!, { pid: 123, sessionId: "session" }); store.close(); store = new RunStore(path);
    store.recoverExpired(40); expect(store.get(afterId)?.status).toBe("needs_reconciliation");
    const done = store.enqueue({ idempotencyKey: "done", stage: "testing", priority: 1, now: 41 });
    const claimed = store.claimNext({ workerId: "a", leaseMs: 10, now: 42 })!;
    store.persistResult(claimed.id, claimed.leaseToken!, { text: "persisted" }); store.close(); store = new RunStore(path);
    expect(store.get(done.id)?.status).toBe("completed");
    expect(store.claimNext({ workerId: "b", leaseMs: 10, now: 100 })?.id).not.toBe(done.id);
    store.close();
  });

  it("persists launch intent before spawn and reconciles an expired ambiguous attempt", () => {
    const store = new RunStore(makeDb());
    const queued = store.enqueue({ idempotencyKey: "launch-intent", stage: "planning", priority: 1, now: 1 });
    const claimed = store.claimNext({ workerId: "worker", leaseMs: 10, now: 2 })!;

    store.markLaunchIntent(claimed.id, claimed.leaseToken!, {
      phase: "launching",
      agent: "codex",
    });
    expect(store.get(queued.id)).toMatchObject({
      status: "claimed",
      launched: true,
      launchInfo: { phase: "launching", agent: "codex" },
    });
    expect(() => store.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!,
      providerResult: { kind: "cli_missing" }, effect: { type: "review" }, status: "failed" }))
      .toThrow(/ambiguous launch/i);
    expect(() => store.fail(claimed.id, claimed.leaseToken!, { kind: "cli_missing" }))
      .toThrow(/requires reconciliation/i);
    expect(store.recoverExpired(13)).toBe(1);
    expect(store.get(queued.id)?.status).toBe("needs_reconciliation");
    expect(store.claimNext({ workerId: "other", leaseMs: 10, now: 14 })).toBeUndefined();
    store.close();
  });

  it("persists exact proven-no-spawn identity when launch intent is synchronously cleared", () => {
    const store = new RunStore(makeDb());
    const queued = store.enqueue({ idempotencyKey: "proven-no-spawn", stage: "planning",
      priority: 1, now: 1 });
    const claimed = store.claimNext({ workerId: "worker", leaseMs: 10, now: 2 })!;
    store.recordExecutionContext(claimed.id, claimed.leaseToken!, { traceId: "trace-1" });
    store.markLaunchIntent(claimed.id, claimed.leaseToken!, {
      agent: "grok", model: "grok-4.6", effort: "high", policyVersion: "routing-v5",
      sessionId: "session-1",
    });

    store.clearLaunchIntent(claimed.id, claimed.leaseToken!);

    expect(store.get(queued.id)).toMatchObject({
      status: "claimed",
      launched: false,
      launchInfo: {
        phase: "proven_no_spawn",
        agent: "grok",
        model: "grok-4.6",
        effort: "high",
        policyVersion: "routing-v5",
        sessionId: "session-1",
        executionContext: { traceId: "trace-1" },
      },
    });
    store.close();
  });

  it("blocks dependent work until its durable coordination prerequisite completes", () => {
    const store = new RunStore(makeDb());
    const coordination = store.enqueue({ idempotencyKey: "task:coordination", stage: "coordination", priority: 10, now: 1 });
    const planning = store.enqueue({ idempotencyKey: "task:planning", stage: "planning", priority: 0, now: 2, dependsOnRunId: coordination.id });
    const first = store.claimNext({ workerId: "w", leaseMs: 100, now: 3 })!;
    expect(first.id).toBe(coordination.id);
    store.complete(first.id, first.leaseToken!, { text: "coordinated" });
    expect(store.claimNext({ workerId: "w", leaseMs: 100, now: 4 })?.id).toBe(planning.id);
    store.close();
  });

  it("renews live leases and leaves unknown post-launch work for explicit reconciliation", () => {
    const path = makeDb();
    const store = new RunStore(path);
    const run = store.enqueue({ idempotencyKey: "mutable", stage: "tdd_coding", priority: 1, now: 1,
      approvalScope: "workspace-write", payload: { prompt: "implement" } });
    const claimed = store.claimNext({ workerId: "w", leaseMs: 10, now: 2 })!;
    store.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "codex" });
    store.markLaunched(claimed.id, claimed.leaseToken!, { pid: 123 });
    expect(store.renewLease(claimed.id, claimed.leaseToken!, 100)).toBe(true);
    expect(store.recoverExpired(99)).toBe(0);
    expect(store.recoverExpired(101)).toBe(1);
    expect(store.get(run.id)?.status).toBe("needs_reconciliation");
    store.close();
    const reopened = new RunStore(path);
    expect(reopened.recoverExpired(102)).toBe(0);
    expect(reopened.get(run.id)).toMatchObject({
      status: "needs_reconciliation",
      launched: true,
      launchInfo: { pid: 123 },
    });
    expect(reopened.claimNext({ workerId: "other", leaseMs: 10, now: 103 })).toBeUndefined();
    reopened.close();
  });
});
