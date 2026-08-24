import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../src/store/run-store.js";

const roots: string[] = [];
const makeDb = () => { const root = mkdtempSync(join(tmpdir(), "agent-collab-store-")); roots.push(root); return join(root, "state.db"); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable run store", () => {
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
    store.markLaunched(after.id, after.leaseToken!, { pid: 123, sessionId: "session" }); store.close(); store = new RunStore(path);
    store.recoverExpired(40); expect(store.get(afterId)?.status).toBe("needs_reconciliation");
    const done = store.enqueue({ idempotencyKey: "done", stage: "testing", priority: 1, now: 41 });
    const claimed = store.claimNext({ workerId: "a", leaseMs: 10, now: 42 })!;
    store.persistResult(claimed.id, claimed.leaseToken!, { text: "persisted" }); store.close(); store = new RunStore(path);
    expect(store.get(done.id)?.status).toBe("completed");
    expect(store.claimNext({ workerId: "b", leaseMs: 10, now: 100 })?.id).not.toBe(done.id);
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
