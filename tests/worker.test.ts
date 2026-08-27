import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurableWorker } from "../src/worker/durable-worker.js";
import { RunStore } from "../src/store/run-store.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import {
  assertPersistedDomainEffectMatchesRun,
  isTransientSqliteError,
  parsePersistedDomainEffect,
} from "../src/worker/domain-effect.js";

const stateDatabase = (root: string): string => {
  const path = join(root, "state.db");
  initializeCurrentExecutionSchema(path);
  return path;
};

describe("worker contention", () => {
  it("starts one external process for one durable command", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-"));
    try {
      const path = stateDatabase(root); const seed = new RunStore(path);
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
      const path = stateDatabase(root); const store = new RunStore(path);
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
      const path = stateDatabase(root); const store = new RunStore(path);
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

  it("does not create a generic replay from provider-supplied review output", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-replay-"));
    try {
      const path = stateDatabase(root); const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "review", stage: "review:auditor", priority: 5, now: 1 });
      const replay = { preferredAgent: "grok", project: "/repo", prompt: "audit", approvalScope: "workspace-read", allowFallback: false, replayOnly: true };
      const worker = new DurableWorker({
        store,
        workerId: "replay-worker",
        runner: async () => ({ kind: "success", text: "degraded audit", deferredReplay: replay }),
      });
      await worker.runOnce(10);
      expect(store.get(queued.id)?.status).toBe("completed");
      expect(store.list()).toEqual([expect.objectContaining({ id: queued.id, status: "completed" })]);
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("persists a pending domain effect before running fallible state transitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-domain-effect-"));
    try {
      const path = stateDatabase(root); const store = new RunStore(path);
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
      expect(store.claimDomainEffect(queued.id, { owner: "test", now: 20, leaseMs: 100 })).toBe(true);
      expect(store.markDomainEffectApplied(queued.id, "test")).toBe(true);
      expect(store.pendingDomainEffects()).toEqual([]);
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not commit a domain effect after the queue lease was fenced", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-domain-fence-"));
    try {
      const path = stateDatabase(root); const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "fenced", stage: "planning", priority: 1, now: 1 });
      const recovery = new RunStore(path);
      const worker = new DurableWorker({ store, workerId: "fenced-worker", leaseMs: 1,
        runner: async (_run, onLaunch, commit, _persistExecutionContext, onLaunchIntent) => {
          onLaunchIntent({ agent: "codex" });
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

  it("reconciles an exception after durable launch evidence instead of recording a plain failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-post-launch-error-"));
    try {
      const path = stateDatabase(root);
      const store = new RunStore(path);
      const queued = store.enqueue({ idempotencyKey: "post-launch-error", stage: "planning", priority: 1, now: 1 });
      const worker = new DurableWorker({
        store,
        workerId: "post-launch-worker",
        runner: async (_run, onLaunch, _commit, _persistExecutionContext, onLaunchIntent) => {
          onLaunchIntent({ agent: "codex" });
          onLaunch({ phase: "started", pid: 42 });
          throw new Error("normalization failed after provider launch");
        },
      });

      await worker.runOnce(10);
      expect(store.get(queued.id)).toMatchObject({
        status: "needs_reconciliation",
        launched: true,
        launchInfo: { phase: "started", pid: 42 },
      });
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles a returned non-success after launch intent instead of failing it normally", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-ambiguous-result-"));
    try {
      const store = new RunStore(stateDatabase(root));
      const queued = store.enqueue({ idempotencyKey: "ambiguous-result", stage: "planning", priority: 1, now: 1 });
      const worker = new DurableWorker({
        store,
        workerId: "ambiguous-result-worker",
        runner: async (_run, _onLaunch, _commit, _persist, onLaunchIntent) => {
          onLaunchIntent({ agent: "codex" });
          return { kind: "task_failure", error: "returned process state is ambiguous" };
        },
      });
      await worker.runOnce(10);
      expect(store.get(queued.id)?.status).toBe("needs_reconciliation");
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles a returned success when launch intent never reached the started fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-ambiguous-success-"));
    try {
      const store = new RunStore(stateDatabase(root));
      const queued = store.enqueue({ idempotencyKey: "ambiguous-success", stage: "planning", priority: 1, now: 1 });
      const worker = new DurableWorker({
        store,
        workerId: "ambiguous-success-worker",
        runner: async (_run, _onLaunch, _commit, _persist, onLaunchIntent) => {
          onLaunchIntent({ phase: "launching", agent: "codex" });
          return { kind: "success", text: "unfenced provider output" };
        },
      });
      await worker.runOnce(10);
      expect(store.get(queued.id)).toMatchObject({
        status: "needs_reconciliation",
        launched: true,
        launchInfo: { phase: "launching", agent: "codex" },
      });
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reconciles a mutable started process when output normalization cannot prove success", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-mutable-normalization-"));
    try {
      const store = new RunStore(stateDatabase(root));
      const queued = store.enqueue({
        idempotencyKey: "mutable-normalization",
        stage: "tdd_coding",
        priority: 2,
        now: 1,
        approvalScope: "workspace-write",
      });
      const dependent = store.enqueue({
        idempotencyKey: "mutable-normalization:dependent",
        stage: "unit_testing",
        priority: 1,
        now: 2,
        dependsOnRunId: queued.id,
      });
      const worker = new DurableWorker({
        store,
        workerId: "mutable-normalization-worker",
        runner: async (_run, onLaunch, commit, _persist, onLaunchIntent) => {
          onLaunchIntent({ phase: "launching", agent: "codex" });
          onLaunch({ phase: "started", pid: 42, agent: "codex" });
          commit({
            providerResult: { kind: "model_unavailable", error: "malformed Codex JSONL parse" },
            effect: { type: "workflow", resultKind: "model_unavailable" },
            status: "completed",
          });
          return { kind: "model_unavailable" };
        },
      });

      await worker.runOnce(10);
      expect(store.get(queued.id)).toMatchObject({
        status: "needs_reconciliation",
        launched: true,
        launchInfo: { phase: "started", pid: 42 },
      });
      expect(store.get(queued.id)?.result).toBeUndefined();
      expect(store.pendingDomainEffects()).toEqual([]);
      expect(store.get(dependent.id)?.status).toBe("queued");
      expect(store.claimNext({ workerId: "other", leaseMs: 100, now: 20 })).toBeUndefined();
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires a domain effect before a mutable started process can complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-mutable-effect-"));
    try {
      const store = new RunStore(stateDatabase(root));
      const queued = store.enqueue({
        idempotencyKey: "mutable-effect",
        stage: "tdd_coding",
        priority: 1,
        now: 1,
        approvalScope: "workspace-write",
      });
      const worker = new DurableWorker({
        store,
        workerId: "mutable-effect-worker",
        runner: async (_run, onLaunch, _commit, _persist, onLaunchIntent) => {
          onLaunchIntent({ phase: "launching", agent: "codex" });
          onLaunch({ phase: "started", pid: 43, agent: "codex" });
          return { kind: "success", text: "validated but not committed" };
        },
      });

      await worker.runOnce(10);
      expect(store.get(queued.id)).toMatchObject({
        status: "needs_reconciliation",
        launched: true,
        launchInfo: { phase: "started", pid: 43 },
      });
      expect(store.get(queued.id)?.result).toBeUndefined();
      worker.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("quarantines one poison domain effect without leaving it in the replay queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-domain-quarantine-"));
    try {
      const store = new RunStore(stateDatabase(root));
      const queued = store.enqueue({ idempotencyKey: "poison", stage: "planning", priority: 1, now: 1 });
      const claimed = store.claimNext({ workerId: "poison-worker", leaseMs: 100, now: 2 })!;
      store.commitDomainEffect({
        id: claimed.id,
        token: claimed.leaseToken!,
        providerResult: { kind: "success" },
        effect: { type: "unsupported-effect" },
        status: "completed",
      });
      expect(store.pendingDomainEffects().map((run) => run.id)).toEqual([queued.id]);
      expect(store.claimDomainEffect(queued.id, { owner: "quarantine", now: 20, leaseMs: 100 })).toBe(true);
      expect(store.quarantineDomainEffect(queued.id, "quarantine", new Error("unsupported persisted effect"))).toBe(true);
      expect(store.pendingDomainEffects()).toEqual([]);
      expect(store.get(queued.id)?.result).toMatchObject({
        domainEffect: "quarantined",
        quarantineError: {
          kind: "domain_effect_quarantined",
          error: "unsupported persisted effect",
        },
      });
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fences concurrent domain-effect replay and permits expired-claim recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-domain-replay-claim-"));
    try {
      const path = stateDatabase(root);
      const first = new RunStore(path); const second = new RunStore(path);
      const queued = first.enqueue({ idempotencyKey: "claim", stage: "planning", priority: 1, now: 1 });
      const claimed = first.claimNext({ workerId: "seed", leaseMs: 100, now: 2 })!;
      first.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!,
        providerResult: { kind: "success" }, effect: { type: "workflow" }, status: "completed" });
      expect(first.claimDomainEffect(queued.id, { owner: "first", now: 10, leaseMs: 100 })).toBe(true);
      expect(second.claimDomainEffect(queued.id, { owner: "second", now: 11, leaseMs: 100 })).toBe(false);
      expect(second.pendingDomainEffects(109)).toEqual([]);
      expect(second.pendingDomainEffects(110).map((run) => run.id)).toEqual([queued.id]);
      expect(second.claimDomainEffect(queued.id, { owner: "second", now: 110, leaseMs: 100 })).toBe(true);
      expect(first.markDomainEffectApplied(queued.id, "first")).toBe(false);
      expect(second.markDomainEffectApplied(queued.id, "second")).toBe(true);
      first.close(); second.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects malformed known domain effects instead of retrying them forever", () => {
    expect(() => parsePersistedDomainEffect({
      type: "workflow",
      workflowId: "wf",
      stageId: "planning",
      terminalAt: 1,
    })).toThrow(/domain-effect schema/i);
  });

  it("binds persisted workflow effects to the immutable run, nested receipt, and provider result", () => {
    const assignment = {
      agent: "codex" as const,
      model: "gpt-5.6-sol" as const,
      effort: "medium" as const,
      policyVersion: "routing-v5" as const,
      reasons: ["stage_baseline:planning:medium"],
      degraded: false,
      attemptId: "planning:attempt:0:codex:routing-v5",
      attemptOrdinal: 0,
      sessionId: "11111111-1111-4111-8111-111111111111",
    };
    const run = {
      id: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "wf:dispatch:0",
      stage: "planning",
      priority: 1,
      status: "completed" as const,
      createdAt: 1,
      nextAttemptAt: 1,
      launched: true,
      attemptCount: 1,
      payload: {
        workflowId: "wf",
        workflowStageId: "stage-planning",
        workflowDispatchIdentity: assignment,
      },
    };
    const runnerReceipt = {
      schemaVersion: "runner-outcome/v1" as const,
      runId: run.id,
      runAttemptCount: 1,
      dispatchId: run.idempotencyKey,
      workflowId: "wf",
      stageId: "stage-planning",
      attemptId: assignment.attemptId,
      attemptOrdinal: assignment.attemptOrdinal,
      agent: assignment.agent,
      model: assignment.model,
      policyVersion: assignment.policyVersion,
      sessionId: assignment.sessionId,
      resultKind: "success" as const,
    };
    const effect = parsePersistedDomainEffect({
      type: "workflow",
      workflowId: "wf",
      stageId: "stage-planning",
      assignment,
      agent: "codex",
      resultKind: "success",
      runnerReceipt,
      terminalAt: 2,
    });
    if (effect.type !== "workflow") throw new Error("expected workflow domain effect");
    expect(() => assertPersistedDomainEffectMatchesRun(
      run,
      { kind: "success", agent: "codex" },
      effect,
    )).not.toThrow();
    expect(() => assertPersistedDomainEffectMatchesRun(
      run,
      { kind: "success", agent: "codex" },
      { ...effect, stageId: "contradictory-stage" },
    )).toThrow(/immutable workflow stage id/i);
    expect(() => assertPersistedDomainEffectMatchesRun(
      run,
      { kind: "success", agent: "codex" },
      { ...effect, runnerReceipt: { ...runnerReceipt, workflowId: "other-workflow" } },
    )).toThrow(/immutable runner receipt/i);
    expect(() => assertPersistedDomainEffectMatchesRun(
      { ...run, status: "failed" },
      { kind: "success", agent: "codex" },
      effect,
    )).toThrow(/immutable outer run status/i);
  });

  it("keeps SQLite contention transient for domain-effect replay", () => {
    expect(isTransientSqliteError(new Error("SQLITE_BUSY: database is locked"))).toBe(true);
    expect(isTransientSqliteError(new Error("unknown persisted review attempt"))).toBe(false);
  });

  it("persists Claude review effects without granting Claude workflow authority", () => {
    expect(parsePersistedDomainEffect({
      type: "review",
      reviewId: "review-claude",
      attemptId: "33333333-3333-4333-8333-333333333333",
      role: "critic",
      agent: "claude",
      resultKind: "success",
      terminalAt: 2,
    })).toMatchObject({
      type: "review",
      reviewId: "review-claude",
      agent: "claude",
      role: "critic",
    });
  });

  it("does not cancel descendants after a stale failure lease is fenced", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-worker-stale-failure-"));
    try {
      const path = stateDatabase(root);
      const store = new RunStore(path);
      const parent = store.enqueue({ idempotencyKey: "parent", stage: "coordination", priority: 0, now: 1 });
      const child = store.enqueue({ idempotencyKey: "child", stage: "planning", priority: 1,
        dependsOnRunId: parent.id, now: 2 });
      const claimed = store.claimNext({ workerId: "stale", leaseMs: 1, now: 10 })!;
      const recovery = new RunStore(path);
      recovery.recoverExpired(12);
      expect(() => store.fail(claimed.id, claimed.leaseToken!, { kind: "task_failure" }))
        .toThrow(/stale lease/i);
      expect(store.get(child.id)?.status).toBe("queued");
      recovery.close(); store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
