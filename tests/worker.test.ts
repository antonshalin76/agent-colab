import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableWorker } from "../src/worker/durable-worker.js";
import { RunStore } from "../src/store/run-store.js";

describe("worker contention", () => {
  it("starts one external process for one durable command", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-"));
    try {
      const path = join(root, "state.db"); const seed = new RunStore(path);
      seed.enqueue({ idempotencyKey: "one", stage: "planning", priority: 1, now: 1 }); seed.close();
      let launches = 0;
      const runner = async () => { launches += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { kind: "success" as const, text: "ok" }; };
      const a = new DurableWorker({ store: new RunStore(path), workerId: "a", runner });
      const b = new DurableWorker({ store: new RunStore(path), workerId: "b", runner });
      await Promise.all([a.runOnce(10), b.runOnce(10)]);
      expect(launches).toBe(1); a.close(); b.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps provider outages queued with bounded retry instead of losing the task", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-retry-"));
    try {
      const path = join(root, "state.db"); const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "retry", stage: "planning", priority: 1, now: 1 });
      const worker = new DurableWorker({
        store,
        workerId: "retry-worker",
        runner: async () => ({ kind: "auth", error: "provider unavailable" }),
      });
      await worker.runOnce(10);
      expect(store.get(queued.id)).toMatchObject({ status: "queued", attemptCount: 1, nextAttemptAt: 30_010 });
      expect(await worker.runOnce(11)).toBeUndefined();
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails a terminal coordination outcome and cancels queued descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-failed-dependency-"));
    try {
      const path = join(root, "state.db"); const store = new RunStore(path);
      const coordination = store.enqueue({ idempotencyKey: "coord", stage: "coordination", priority: 0, now: 1 });
      const planning = store.enqueue({ idempotencyKey: "plan", stage: "planning", priority: 1, now: 2, dependsOnRunId: coordination.id });
      const worker = new DurableWorker({ store, workerId: "failure-worker",
        runner: async () => ({ kind: "permission_denial", error: "denied" }) });
      await worker.runOnce(10);
      expect(store.get(coordination.id)?.status).toBe("failed");
      expect(store.get(planning.id)).toMatchObject({ status: "cancelled", cancelReason: "dependency_failed" });
      expect(await worker.runOnce(11)).toBeUndefined();
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists a deferred cross-provider replay after a degraded review succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-replay-"));
    try {
      const path = join(root, "state.db"); const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "review", stage: "review:auditor", priority: 5, now: 1 });
      const replay = { preferredAgent: "grok", project: "/repo", prompt: "audit", approvalScope: "workspace-read", allowFallback: false, replayOnly: true };
      const worker = new DurableWorker({
        store,
        workerId: "replay-worker",
        runner: async () => ({ kind: "success", text: "degraded audit", deferredReplay: replay }),
      });
      await worker.runOnce(10);
      expect(store.get(queued.id)?.status).toBe("completed");
      expect(store.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: "review:cross-provider-replay",
          status: "queued",
          nextAttemptAt: 60_010,
          payload: replay,
        }),
      ]));
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists a pending domain effect before running fallible state transitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-domain-effect-"));
    try {
      const path = join(root, "state.db"); const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "domain", stage: "planning", priority: 1, now: 1 });
      const worker = new DurableWorker({ store, workerId: "domain-worker",
        runner: async (_run, _onLaunch, commit) => {
          commit({ providerResult: { kind: "success", text: "done" },
            effect: { type: "workflow", workflowId: "wf" }, status: "completed" });
          throw new Error("simulated crash after queue commit");
        } });

      await worker.runOnce(10);
      expect(store.get(queued.id)).toMatchObject({
        status: "completed",
        result: { domainEffect: "pending", providerResult: { kind: "success", text: "done" } },
      });
      expect(store.pendingDomainEffects().map((run) => run.id)).toEqual([queued.id]);
      expect(store.markDomainEffectApplied(queued.id)).toBe(true);
      expect(store.pendingDomainEffects()).toEqual([]);
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not commit a domain effect after the queue lease was fenced", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-domain-fence-"));
    try {
      const path = join(root, "state.db"); const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "fenced", stage: "planning", priority: 1, now: 1 });
      const recovery = new RunStore(path);
      const worker = new DurableWorker({ store, workerId: "fenced-worker", leaseMs: 1,
        runner: async (_run, onLaunch, commit) => {
          onLaunch({ phase: "started" });
          recovery.recoverExpired(12);
          commit({ providerResult: { kind: "success" }, effect: { type: "workflow" }, status: "completed" });
          return { kind: "success" };
        } });

      await worker.runOnce(10);
      expect(store.get(queued.id)?.status).toBe("needs_reconciliation");
      expect(store.pendingDomainEffects()).toEqual([]);
      worker.close(); recovery.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
