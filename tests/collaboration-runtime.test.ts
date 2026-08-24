import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CollaborationRuntime } from "../src/runtime/collaboration-runtime.js";
import { RunStore } from "../src/store/run-store.js";
import {
  createCollaborationRun,
  type ActiveStage,
  type AttemptAssignment,
  type CheckpointEvidence,
} from "../src/workflow/workflow.js";

const fixture = (project: string) =>
  createCollaborationRun({
    taskId: `scope:${project}:task`,
    origin: "grok",
    health: { grok: "healthy", codex: "healthy" },
    stages: [
      {
        id: "planning",
        kind: "planning",
        role: "stage-owner",
        artifactRef: "artifact:a",
        artifactHash: "a".repeat(64),
        artifactBytes: 2_048,
        changedFiles: 3,
        approvalScope: "workspace-read",
        idempotencyKey: "scoped:planning",
        project,
        prompt: "plan",
        requester: "grok",
      },
      {
        id: "review",
        kind: "code_review",
        role: "stage-owner",
        artifactRef: "artifact:a",
        artifactHash: "a".repeat(64),
        artifactBytes: 2_048,
        changedFiles: 3,
        approvalScope: "workspace-read",
        idempotencyKey: "scoped:review",
        project,
        prompt: "review",
        requester: "grok",
      },
    ],
  });

const checkpointFor = (active: ActiveStage): CheckpointEvidence => ({
  artifactHash: active.artifactHash,
  headSha: "h",
  diffHash: "d",
  changedFiles: [],
  testEvidence: [],
  sourceSessionId: "s",
  approvals: [],
  nextAction: {
    kind: "continue_stage",
    stageId: active.id,
    instruction: "continue",
  },
});

const completeCoordination = (
  runtime: CollaborationRuntime,
  workflowId: string,
  active: ActiveStage,
  now = 2,
) => runtime.completeStage(workflowId, active.id, active.assignment, { kind: "success" }, now);

const providerOutcome = (
  runtime: CollaborationRuntime,
  workflowId: string,
  active: ActiveStage,
  input: {
    from: "grok" | "codex";
    toHealth: { grok: "healthy" | "unavailable"; codex: "healthy" | "unavailable" };
    leaseId: string;
    fencingToken: number;
    attemptId: string;
  },
  now: number,
) => runtime.recordProviderOutcome(workflowId, {
  from: input.from,
  outcome: { kind: "network_timeout" },
  health: input.toHealth,
  checkpoint: checkpointFor(active),
  lease: {
    worktreePath: active.project!,
    leaseId: input.leaseId,
    holder: input.from,
    fencingToken: input.fencingToken,
  },
  observed: {
    artifactHash: active.artifactHash,
    headSha: "h",
    diffHash: "d",
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
  },
  assignment: active.assignment,
  outcomeEventId: input.attemptId,
}, now);

const seedLease = (database: string, input: {
  worktreePath: string;
  taskId: string;
  leaseId: string;
  holder: "grok" | "codex";
  fencingToken: number;
  expiresAt?: number;
}): void => {
  const db = new Database(database);
  db.prepare(`INSERT OR REPLACE INTO worktree_leases
    (worktree_path,task_id,lease_id,holder,fencing_token,expires_at)
    VALUES (?,?,?,?,?,?)`).run(input.worktreePath, input.taskId, input.leaseId,
      input.holder, input.fencingToken, input.expiresAt ?? 60_000);
  db.close();
};

describe("v2 collaboration aggregate and transactional outbox", () => {
  it("publishes coordination first and persists exact per-attempt decisions in queue payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-"));
    try {
      const db = join(root, "state.db");
      const runtime = new CollaborationRuntime(db);
      const runs = new RunStore(db);
      const initial = runtime.createAndStart("wf", fixture(root), 1);

      expect(initial.activeStage).toMatchObject({
        kind: "coordination",
        assignment: {
          agent: "codex",
          model: "gpt-5.6-sol",
          effort: "medium",
          policyVersion: "routing-v3",
          reasons: ["stage_baseline:coordination:medium"],
          attemptOrdinal: 0,
        },
      });
      expect(runtime.drainDispatchOutbox(runs, 2)).toBe(1);
      const coordinationRun = runs.list()[0]!;
      expect(coordinationRun.payload?.workflowDispatchIdentity).toEqual(
        initial.activeStage!.assignment,
      );
      expect(coordinationRun.payload?.decision).toEqual({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        policyVersion: "routing-v3",
        reasons: ["stage_baseline:coordination:medium"],
        degraded: false,
      });
      expect(coordinationRun.payload?.sessionId).toBe(initial.activeStage!.assignment.sessionId);

      const planning = completeCoordination(runtime, "wf", initial.activeStage!, 3);
      expect(planning.activeStage?.id).toBe("planning");
      expect(runtime.drainDispatchOutbox(runs, 4)).toBe(1);
      expect(runs.list().map((run) => run.stage).sort()).toEqual([
        "coordination",
        "planning",
      ]);
      expect(runs.getByIdempotencyKey("wf:dispatch:1")?.payload?.workflowDispatchIdentity)
        .toEqual(planning.activeStage!.assignment);
      expect(runs.getByIdempotencyKey("wf:dispatch:1")?.payload?.sessionId)
        .toBe(planning.activeStage!.assignment.sessionId);
      expect(planning.activeStage!.assignment.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const claimAt = Date.now() + 1_000;
      const coordination = runs.claimNext({ workerId: "one", leaseMs: 100, now: claimAt })!;
      expect(coordination.stage).toBe("coordination");
      expect(runs.claimNext({ workerId: "two", leaseMs: 100, now: claimAt })).toBeUndefined();
      runs.persistResult(coordination.id, coordination.leaseToken!, { kind: "success" });
      expect(runs.claimNext({ workerId: "two", leaseMs: 100, now: claimAt + 1 })?.stage)
        .toBe("planning");
      runtime.close();
      runs.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not publish a downstream stage after terminal coordination failure", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-failure-"));
    try {
      const db = join(root, "state.db");
      const runtime = new CollaborationRuntime(db);
      const runs = new RunStore(db);
      runtime.createAndStart("wf", fixture(root), 1);
      runtime.drainDispatchOutbox(runs, 2);
      const active = runtime.workflows.get("wf")!.activeStage!;
      expect(runtime.recordTerminalOutcome("wf", active.assignment, { kind: "permission_denial" }, 3).status)
        .toBe("terminal_outcome");
      expect(runtime.drainDispatchOutbox(runs, 4)).toBe(0);
      expect(runs.list().map((run) => run.stage)).toEqual(["coordination"]);
      runtime.close();
      runs.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays an unacknowledged exact outbox dispatch without duplicating the queue command", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-crash-"));
    try {
      const db = join(root, "state.db");
      const first = new CollaborationRuntime(db);
      const runs = new RunStore(db);
      first.createAndStart("wf", fixture(root), 1);
      expect(first.drainDispatchOutbox(runs, 2)).toBe(1);
      const original = structuredClone(runs.list()[0]);
      first.close();

      const sqlite = new Database(db);
      sqlite.prepare("UPDATE collaboration_dispatch_outbox SET published_at=NULL").run();
      sqlite.close();

      const recovered = new CollaborationRuntime(db);
      expect(recovered.drainDispatchOutbox(runs, 3)).toBe(1);
      expect(runs.list()).toHaveLength(1);
      expect(runs.list()[0]).toEqual(original);
      expect(recovered.workflows.pendingDispatches()).toEqual([]);
      recovered.close();
      runs.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an idempotency collision with different queued decision bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-queue-conflict-"));
    try {
      const db = join(root, "state.db");
      const runtime = new CollaborationRuntime(db);
      const runs = new RunStore(db);
      runtime.createAndStart("wf", fixture(root), 1);
      runs.enqueue({
        idempotencyKey: "wf:dispatch:0",
        stage: "coordination",
        priority: 0,
        payload: { workflowDispatchIdentity: { attemptId: "forged" } },
      });
      expect(() => runtime.drainDispatchOutbox(runs, 2))
        .toThrow(/dispatch id conflicts with immutable queue payload/i);
      expect(runtime.workflows.pendingDispatches()).toHaveLength(1);
      runtime.close();
      runs.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists fallback before publishing and gates execution on the full decision identity", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-failover-"));
    try {
      const db = join(root, "state.db");
      const runtime = new CollaborationRuntime(db);
      const runs = new RunStore(db);
      const coordination = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const planning = completeCoordination(runtime, "wf", coordination, 3).activeStage!;
      runtime.drainDispatchOutbox(runs, 4);
      const initialDecision = structuredClone(planning.assignment);
      seedLease(db, { worktreePath: root, taskId: "wf", leaseId: "lease", holder: "grok", fencingToken: 1 });

      const failedOver = providerOutcome(runtime, "wf", planning, {
        from: "grok",
        toHealth: { grok: "unavailable", codex: "healthy" },
        leaseId: "lease",
        fencingToken: 1,
        attemptId: "runner:1",
      }, 5);
      const fallback = failedOver.activeStage!.assignment;

      expect(fallback).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        policyVersion: "routing-v3",
        reasons: [
          "stage_baseline:planning:medium",
          "degraded_fallback",
          "retry",
        ],
        attemptOrdinal: 1,
      });
      expect(runtime.dispatchDisposition("wf", planning.id, initialDecision)).toBe("superseded");
      expect(runtime.dispatchDisposition("wf", planning.id, fallback)).toBe("execute");
      expect(runtime.workflows.pendingDispatches()[0]?.stage.assignment).toEqual(fallback);

      const sameAgentWrongAttempt: AttemptAssignment = {
        ...fallback,
        attemptId: `${fallback.attemptId}:stale`,
      };
      expect(runtime.dispatchDisposition("wf", planning.id, sameAgentWrongAttempt))
        .toBe("superseded");

      expect(runtime.drainDispatchOutbox(runs, 6)).toBe(1);
      expect(runs.getByIdempotencyKey("wf:dispatch:2")?.payload?.workflowDispatchIdentity)
        .toEqual(fallback);
      runtime.close();
      runs.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a late result from the assignment that was superseded by failover", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-late-result-"));
    try {
      const db = join(root, "state.db");
      const runtime = new CollaborationRuntime(db);
      const coordination = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      const planning = completeCoordination(runtime, "wf", coordination, 2).activeStage!;
      seedLease(db, { worktreePath: root, taskId: "wf", leaseId: "lease", holder: "grok", fencingToken: 1 });
      const failedOver = providerOutcome(runtime, "wf", planning, {
        from: "grok",
        toHealth: { grok: "unavailable", codex: "healthy" },
        leaseId: "lease",
        fencingToken: 1,
        attemptId: "runner:late",
      }, 3);

      expect(failedOver.activeStage?.assignment.agent).toBe("codex");
      expect(() => runtime.completeStage("wf", planning.id, planning.assignment, { kind: "success" }, 4))
        .toThrow(/stale workflow assignment/i);
      expect(runtime.workflows.get("wf")?.activeStage?.assignment.agent).toBe("codex");
      expect(runtime.workflows.get("wf")?.completedStageIds).not.toContain(planning.id);
      runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent workflow-id collision when static trusted inputs differ", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-idempotency-"));
    try {
      const db = join(root, "state.db");
      const first = new CollaborationRuntime(db);
      const second = new CollaborationRuntime(db);
      first.createAndStart("wf", fixture(root), 1);
      const conflicting = fixture(root);
      conflicting.stages[1]!.changedFiles = 99;
      expect(() => second.createAndStart("wf", conflicting, 2))
        .toThrow("workflow id conflicts with immutable collaboration input");
      first.close();
      second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attaches handoff evidence only to the dispatch created by failover", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-handoff-scope-"));
    try {
      const runtime = new CollaborationRuntime(join(root, "state.db"));
      const coordination = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      const planning = completeCoordination(runtime, "wf", coordination, 2).activeStage!;
      const failedOver = providerOutcome(runtime, "wf", planning, {
        from: "grok",
        toHealth: { grok: "unavailable", codex: "healthy" },
        leaseId: "lease",
        fencingToken: 1,
        attemptId: "runner:1",
      }, 3);
      const fallback = runtime.workflows.pendingDispatches()
        .find((item) => item.stage.assignment.attemptOrdinal === 1)!;
      expect(fallback.handoff?.eventId).toBe(fallback.dispatch.handoffEventId);

      runtime.completeStage("wf", planning.id, failedOver.activeStage!.assignment, { kind: "success" }, 4);
      const review = runtime.workflows.pendingDispatches()
        .find((item) => item.stage.id === "review")!;
      expect(review.stage.assignment.agent).toBe("codex");
      expect(review.handoff).toBeUndefined();
      expect(failedOver.handoffs).toHaveLength(1);
      runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not deduplicate the same outcome after ownership cycles back", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-repeat-outcome-"));
    try {
      const runtime = new CollaborationRuntime(join(root, "state.db"));
      const coordination = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      const planning = completeCoordination(runtime, "wf", coordination, 2).activeStage!;
      const first = providerOutcome(runtime, "wf", planning, {
        from: "grok",
        toHealth: { grok: "unavailable", codex: "healthy" },
        leaseId: "one",
        fencingToken: 1,
        attemptId: "runner:1",
      }, 3);
      const second = providerOutcome(runtime, "wf", first.activeStage!, {
        from: "codex",
        toHealth: { grok: "healthy", codex: "unavailable" },
        leaseId: "two",
        fencingToken: 2,
        attemptId: "runner:2",
      }, 4);

      expect(first.activeStage?.assignment).toMatchObject({ agent: "codex", attemptOrdinal: 1 });
      expect(second.activeStage?.assignment).toMatchObject({ agent: "grok", attemptOrdinal: 2 });
      expect(second.handoffs).toHaveLength(2);
      expect(second.dispatches.filter((item) => item.stageId === "planning")).toHaveLength(3);
      expect(new Set(second.handoffs.map((handoff) => handoff.eventId)).size).toBe(2);
      runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-evaluates a failed attempt after the alternate recovers without double-counting it", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-provider-recovery-"));
    try {
      const runtime = new CollaborationRuntime(join(root, "state.db"));
      const coordination = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      const planning = completeCoordination(runtime, "wf", coordination, 2).activeStage!;
      const blocked = providerOutcome(runtime, "wf", planning, {
        from: "grok",
        toHealth: { grok: "unavailable", codex: "unavailable" },
        leaseId: "one",
        fencingToken: 1,
        attemptId: "runner:1",
      }, 3);
      const recovered = runtime.workflows.applyMany("wf", [
        { type: "PROVIDER_HEALTH_CHANGED", agent: "codex", health: "healthy" },
        { type: "RECOVERY_TIMER_FIRED", eventId: "recovery:codex", now: 1_003 },
      ], 1_003);

      expect(blocked.status).toBe("blocked_no_provider");
      expect(blocked.failedAttempts).toHaveLength(1);
      expect(recovered.activeStage?.assignment).toMatchObject({
        agent: "codex",
        attemptOrdinal: 1,
      });
      expect(recovered.failedAttempts).toHaveLength(1);
      runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks the workflow when durable lease transfer is fenced", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-fenced-transfer-"));
    try {
      const db = join(root, "state.db");
      const runtime = new CollaborationRuntime(db);
      const runs = new RunStore(db);
      const coordination = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const planning = completeCoordination(runtime, "wf", coordination, 3).activeStage!;
      runtime.drainDispatchOutbox(runs, 4);
      seedLease(db, { worktreePath: root, taskId: "wf", leaseId: "different", holder: "grok", fencingToken: 9 });
      providerOutcome(runtime, "wf", planning, {
        from: "grok",
        toHealth: { grok: "unavailable", codex: "healthy" },
        leaseId: "expected",
        fencingToken: 1,
        attemptId: "runner:fenced",
      }, 5);

      expect(runtime.drainDispatchOutbox(runs, 6)).toBe(0);
      expect(runtime.workflows.get("wf")).toMatchObject({
        status: "blocked_handoff_conflict",
        blockedReason: "worktree_lease_transfer_fenced",
        activeStage: null,
        conflict: { expectedFencingToken: 1, currentFencingToken: 9 },
      });
      expect(runtime.workflows.pendingDispatches()).toEqual([]);
      expect(runtime.drainDispatchOutbox(runs, 7)).toBe(0);
      runtime.close();
      runs.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats terminal and missing aggregates as non-executable", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runtime-terminal-reconcile-"));
    try {
      const runtime = new CollaborationRuntime(join(root, "state.db"));
      const state = runtime.createAndStart("wf", fixture(root), 1);
      const assignment = state.activeStage!.assignment;
      runtime.recordTerminalOutcome("wf", assignment, { kind: "permission_denial" }, 2);
      expect(runtime.dispatchDisposition("wf", state.activeStage!.id, assignment)).toBe("terminal");
      expect(runtime.dispatchDisposition("missing", state.activeStage!.id, assignment)).toBe("terminal");
      runtime.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
