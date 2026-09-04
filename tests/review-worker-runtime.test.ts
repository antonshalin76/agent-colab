import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewWorkerRuntime } from "../src/app/review-worker-runtime.js";
import { ReviewWorkerService } from "../src/app/review-worker-service.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { ProviderHealthStore } from "../src/runtime/provider-health-store.js";
import { ReviewEvidenceCapture } from "../src/runtime/review-evidence-capture.js";
import {
  RunGateUnitOfWork,
  type CreateReviewBarrierInput,
  type ReviewAdmissionReceiptPair,
} from "../src/runtime/run-gate-unit-of-work.js";
import { RunStore } from "../src/store/run-store.js";
import type { ProcessTask } from "../src/runners/agent-runner.js";

const roots: string[] = [];
const SOURCE = "review-worker-source-v1";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-review-worker-"));
  roots.push(root);
  const path = join(root, "state.db");
  initializeCurrentExecutionSchema(path);
  return path;
}

function evidenceCapture(): ReviewEvidenceCapture {
  let observedAt = 100;
  return new ReviewEvidenceCapture({
    captureSource: () => ({ sourceFingerprint: SOURCE, valid: true }),
    captureReadiness: () => ({ harnessReady: true, state: "ready", valid: true }),
    observedAt: () => observedAt++,
  });
}

function seedReview(
  path: string,
  reviewId: string,
  active: readonly ("grok" | "claude" | "codex")[] = ["codex"],
): RunGateUnitOfWork {
  const health = new ProviderHealthStore(path, { cooldownMs: 1_000 });
  for (const agent of active) health.recordSuccess(agent, 1);
  health.close();

  const reviews = new RunGateUnitOfWork(path);
  const admissionReceipts: ReviewAdmissionReceiptPair[] = [];
  for (const agent of active) {
    for (const role of ["auditor", "critic"] as const) {
      const activationNonce = `${reviewId}/${agent}/${role}/admission`;
      const sourceReceiptId = `${activationNonce}/source`;
      const readinessReceiptId = `${activationNonce}/readiness`;
      reviews.captureReviewReceiptPair({
        pairId: activationNonce,
        phase: "admission",
        activationNonce,
        scopeRevision: 1,
        recoveryGeneration: null,
        expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
        predecessorReceiptIds: { source: null, readiness: null },
        receipts: {
          source: {
            receiptId: sourceReceiptId,
            scope: `review/${reviewId}/${agent}/${role}/source`,
            observation: { sourceFingerprint: SOURCE, valid: true },
          },
          readiness: {
            receiptId: readinessReceiptId,
            scope: `review/${reviewId}/${agent}/${role}/readiness`,
            observation: { harnessReady: true, state: "ready", valid: true },
          },
        },
        createdAt: 1,
      });
      admissionReceipts.push({ agent, role, activationNonce, sourceReceiptId, readinessReceiptId });
    }
  }
  const healthSnapshot = Object.fromEntries(
    (["grok", "claude", "codex"] as const).map((agent) => [
      agent,
      active.includes(agent) ? "healthy" : "unavailable",
    ]),
  ) as CreateReviewBarrierInput["health"];
  reviews.create({
    reviewId,
    stageId: "stg04-runtime-review",
    artifact: Buffer.from(`artifact:${reviewId}`),
    health: healthSnapshot,
    approvalScope: "workspace-read",
    idempotencyKey: `${reviewId}:barrier`,
    prompts: { auditor: "audit the artifact", critic: "challenge the artifact" },
    project: process.cwd(),
    requester: "codex",
    sourceFingerprint: SOURCE,
    changedFiles: 1,
    createdAt: 1,
    admissionReceipts,
  });
  return reviews;
}

function runner(input?: {
  unavailable?: "grok" | "claude" | "codex";
  pause?: Promise<void>;
  launches?: () => void;
}) {
  return {
    run: vi.fn(async (
      task: ProcessTask,
      onLaunch: (info: Record<string, unknown>) => void,
      onLaunchIntent: (info: Record<string, unknown>) => void,
    ) => {
      const payload = task.payload!;
      const decision = payload.decision as Record<string, unknown>;
      const dispatch = payload.reviewDispatchIdentity as Record<string, unknown>;
      const identity = {
        agent: decision.agent,
        model: decision.model,
        effort: decision.effort,
        policyVersion: decision.policyVersion,
        sessionId: dispatch.sessionId,
      };
      onLaunchIntent(identity);
      input?.launches?.();
      await input?.pause;
      onLaunch({ ...identity, pid: 4_000 });
      if (decision.agent === input?.unavailable) {
        return { kind: "model_unavailable", agent: decision.agent };
      }
      return {
        kind: "success",
        agent: decision.agent,
        text: JSON.stringify({
          schemaVersion: "review-verdict/v1",
          verdict: "PASS",
          findings: [],
        }),
      };
    }),
  };
}

function postpone(path: string, reviewId: string, predicate: string): void {
  const db = new Database(path);
  db.prepare(`UPDATE runs SET next_attempt_at=10000 WHERE id IN (
    SELECT run_id FROM runtime_review_lane_attempts WHERE review_id=? AND ${predicate}
  )`).run(reviewId);
  db.close();
}

describe("review-only worker runtime", () => {
  it("lets two runtime instances launch one due review attempt exactly once", async () => {
    const path = database();
    const reviews = seedReview(path, "one-launch");
    postpone(path, "one-launch", "role='critic'");
    const ordinaryStore = new RunStore(path);
    const ordinary = ordinaryStore.enqueue({
      idempotencyKey: "ordinary-workflow",
      stage: "implementation",
      priority: -100,
      now: 0,
      payload: { workflowId: "must-not-claim" },
    });
    ordinaryStore.close();
    let launches = 0;
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const provider = runner({ pause, launches: () => { launches += 1; } });
    const probe = vi.fn(async () => ({ ready: true as const }));
    const a = createReviewWorkerRuntime({ stateDatabase: path, workerId: "review-a",
      runner: provider, evidenceCapture: evidenceCapture(), probe });
    const b = createReviewWorkerRuntime({ stateDatabase: path, workerId: "review-b",
      runner: provider, evidenceCapture: evidenceCapture(), probe });

    const first = a.runOnce(10);
    const second = b.runOnce(10);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([first, second]);

    expect(launches).toBe(1);
    expect(provider.run).toHaveBeenCalledOnce();
    expect(reviews.get("one-launch")?.lanes.find((lane) =>
      lane.agent === "codex" && lane.role === "auditor")).toMatchObject({
        status: "completed",
        result: { kind: "success", agent: "codex", reviewVerdict: { verdict: "PASS" } },
      });
    const proof = new RunStore(path);
    expect(proof.get(ordinary.id)?.status).toBe("queued");
    expect(proof.list().filter((run) => run.result &&
      (run.result as { domainEffect?: string }).domainEffect === "applied")).toHaveLength(1);
    proof.close();
    a.close();
    b.close();
    reviews.close();
  });

  it("recovers durable launch without terminal evidence into reconciliation and never relaunches it", async () => {
    const path = database();
    const reviews = seedReview(path, "ambiguous-launch");
    postpone(path, "ambiguous-launch", "role='critic'");
    const runs = new RunStore(path, { scope: "review" });
    const claimed = runs.claimNext({ workerId: "crashed", leaseMs: 1, now: 10 })!;
    runs.markLaunchIntent(claimed.id, claimed.leaseToken!, { agent: "codex" });
    runs.markLaunched(claimed.id, claimed.leaseToken!, {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      policyVersion: "routing-v5",
      sessionId: claimed.payload?.sessionId,
      pid: 4_001,
    });
    runs.close();
    const provider = runner();
    const runtime = createReviewWorkerRuntime({ stateDatabase: path, workerId: "restart",
      runner: provider, evidenceCapture: evidenceCapture(), probe: async () => ({ ready: true }) });

    await expect(runtime.recover(20)).resolves.toMatchObject({ expired: 1 });
    await expect(runtime.runOnce(21)).resolves.toBeUndefined();

    expect(provider.run).not.toHaveBeenCalled();
    const proof = new RunStore(path, { scope: "review" });
    expect(proof.get(claimed.id)).toMatchObject({
      status: "needs_reconciliation",
      launched: true,
      launchInfo: { phase: "started", pid: 4_001 },
    });
    proof.close();
    runtime.close();
    reviews.close();
  });

  it("reconciles a linked review whose saved provider decision diverges from its attempt", async () => {
    const path = database();
    const reviews = seedReview(path, "decision-mismatch");
    postpone(path, "decision-mismatch", "role='critic'");
    const db = new Database(path);
    const row = db.prepare(`SELECT id,payload FROM runs WHERE id IN (
      SELECT run_id FROM runtime_review_lane_attempts
      WHERE review_id='decision-mismatch' AND role='auditor'
    )`).get() as { id: string; payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    payload.decision = { ...(payload.decision as Record<string, unknown>), model: "grok-4.6" };
    db.prepare("UPDATE runs SET payload=? WHERE id=?").run(JSON.stringify(payload), row.id);
    db.close();
    const provider = runner();
    const runtime = createReviewWorkerRuntime({ stateDatabase: path, workerId: "identity-check",
      runner: provider, evidenceCapture: evidenceCapture(), probe: async () => ({ ready: true }) });

    await runtime.runOnce(10);

    expect(provider.run).not.toHaveBeenCalled();
    const proof = new RunStore(path, { scope: "review" });
    expect(proof.get(row.id)).toMatchObject({
      status: "needs_reconciliation",
    });
    proof.close();
    runtime.close();
    reviews.close();
  });

  it("replays a committed review effect idempotently without another provider launch", async () => {
    const path = database();
    const reviews = seedReview(path, "effect-replay");
    postpone(path, "effect-replay", "role='critic'");
    const provider = runner();
    const first = createReviewWorkerRuntime({ stateDatabase: path, workerId: "first",
      runner: provider, evidenceCapture: evidenceCapture(), probe: async () => ({ ready: true }) });
    await first.runOnce(10);
    first.close();
    const db = new Database(path);
    db.prepare(`UPDATE runs SET result=json_set(result, '$.domainEffect', 'pending')
      WHERE json_extract(result, '$.domainEffect')='applied'`).run();
    db.close();
    const restartedRunner = runner();
    const restarted = createReviewWorkerRuntime({ stateDatabase: path, workerId: "restarted",
      runner: restartedRunner, evidenceCapture: evidenceCapture(), probe: async () => ({ ready: true }) });

    await expect(restarted.replayPendingDomainEffects(20)).resolves.toEqual({
      applied: 1,
      deferred: 0,
      quarantined: 0,
    });

    expect(restartedRunner.run).not.toHaveBeenCalled();
    const proof = new RunStore(path, { scope: "review" });
    expect(proof.pendingDomainEffects(21)).toEqual([]);
    expect(proof.list().find((run) => run.status === "completed")?.result)
      .toMatchObject({ domainEffect: "applied" });
    proof.close();
    restarted.close();
    reviews.close();
  });

  it("does not probe or mutate provider accounting without durable deferred review demand", async () => {
    const path = database();
    const provider = runner();
    const probe = vi.fn(async () => ({ ready: true as const }));
    const runtime = createReviewWorkerRuntime({ stateDatabase: path, workerId: "no-demand",
      runner: provider, evidenceCapture: evidenceCapture(), probe });
    const beforeDb = new Database(path, { readonly: true });
    const before = beforeDb.prepare("SELECT * FROM runtime_provider_health ORDER BY agent").all();
    beforeDb.close();

    await expect(runtime.recoverProviders(10)).resolves.toEqual([]);

    expect(probe).not.toHaveBeenCalled();
    expect(provider.run).not.toHaveBeenCalled();
    const afterDb = new Database(path, { readonly: true });
    expect(afterDb.prepare("SELECT * FROM runtime_provider_health ORDER BY agent").all()).toEqual(before);
    afterDb.close();
    runtime.close();
  });

  it("keeps launched optional-provider unavailability nonblocking under the existing barrier policy", async () => {
    const path = database();
    const reviews = seedReview(path, "optional-unavailable", ["codex", "grok"]);
    const provider = runner({ unavailable: "grok" });
    const options = { stateDatabase: path, runner: provider,
      evidenceCapture: evidenceCapture(), probe: async () => ({ ready: true as const }) };
    const a = createReviewWorkerRuntime({ ...options, workerId: "optional-a" });
    const b = createReviewWorkerRuntime({ ...options, workerId: "optional-b" });

    await a.runOnce(10);
    await a.runOnce(11);
    await Promise.all([a.runOnce(12), b.runOnce(12)]);

    expect(reviews.get("optional-unavailable")?.lanes.filter((lane) => lane.agent === "grok")
      .map((lane) => lane.status).sort()).toEqual(["deferred", "deferred"]);
    expect(reviews.barrier("optional-unavailable")).toEqual({
      satisfied: true,
      terminalCount: 2,
      requiredCount: 2,
    });
    a.close();
    b.close();
    reviews.close();
  });

  it("runs recovery independently from a long execution and drains both loops on stop", async () => {
    let releaseExecution!: () => void;
    const execution = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const worker = {
      runOnce: vi.fn(async () => { await execution; return {}; }),
      stop: vi.fn(() => releaseExecution()),
      close: vi.fn(),
    };
    const control = {
      recover: vi.fn(async () => ({
        expired: 0,
        replay: { applied: 0, deferred: 0, quarantined: 0 },
      })),
      recoverProviders: vi.fn(async () => []),
      stop: vi.fn(),
      close: vi.fn(),
    };
    let clock = 0;
    const pauses: Array<() => void> = [];
    const service = new ReviewWorkerService({
      workers: [worker],
      control,
      recoveryIntervalMs: 30,
      idleIntervalMs: 1,
      now: () => clock,
      delay: () => new Promise<void>((resolve) => pauses.push(resolve)),
    });

    const running = service.run();
    await vi.waitFor(() => {
      expect(worker.runOnce).toHaveBeenCalledOnce();
      expect(control.recover).toHaveBeenCalledOnce();
      expect(pauses).toHaveLength(1);
    });
    clock = 31;
    pauses.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(control.recover).toHaveBeenCalledTimes(2));
    expect(worker.runOnce).toHaveBeenCalledOnce();

    service.stop();
    pauses.splice(0).forEach((resolve) => resolve());
    await running;
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(control.stop).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledOnce();
    expect(control.close).toHaveBeenCalledOnce();
  });

  it("stops and drains every loop before closing resources when one loop fails", async () => {
    let releaseExecution!: () => void;
    const execution = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let executionSettled = false;
    const worker = {
      runOnce: vi.fn(async () => {
        await execution;
        executionSettled = true;
        return {};
      }),
      stop: vi.fn(() => releaseExecution()),
      close: vi.fn(() => {
        expect(executionSettled).toBe(true);
      }),
    };
    const control = {
      recover: vi.fn(async () => { throw new Error("control failure"); }),
      recoverProviders: vi.fn(async () => []),
      stop: vi.fn(),
      close: vi.fn(),
    };
    const service = new ReviewWorkerService({
      workers: [worker],
      control,
      idleIntervalMs: 1,
      delay: async () => {},
    });

    await expect(service.run()).rejects.toThrow("control failure");
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(control.stop).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledOnce();
    expect(control.close).toHaveBeenCalledOnce();
  });

  it("drains an in-flight control recovery probe during shutdown", async () => {
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const pauses: Array<() => void> = [];
    const worker = {
      runOnce: vi.fn(async () => undefined),
      stop: vi.fn(),
      close: vi.fn(),
    };
    const control = {
      recover: vi.fn(async () => ({
        expired: 0,
        replay: { applied: 0, deferred: 0, quarantined: 0 },
      })),
      recoverProviders: vi.fn(async () => { await recovery; return []; }),
      stop: vi.fn(() => releaseRecovery()),
      close: vi.fn(),
    };
    const service = new ReviewWorkerService({
      workers: [worker],
      control,
      idleIntervalMs: 1,
      delay: () => new Promise<void>((resolve) => pauses.push(resolve)),
    });
    const running = service.run();
    await vi.waitFor(() => expect(control.recoverProviders).toHaveBeenCalledOnce());

    service.stop();
    pauses.splice(0).forEach((resolve) => resolve());

    await expect(running).resolves.toBeUndefined();
    expect(control.stop).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
    expect(control.close).toHaveBeenCalledOnce();
    expect(worker.close).toHaveBeenCalledOnce();
  });
});
