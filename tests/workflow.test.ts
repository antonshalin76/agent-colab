import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROUTING_POLICY_VERSION,
  type ActiveAgentId,
  type ProviderHealthSnapshot,
  type Stage,
} from "../src/domain/routing.js";
import {
  createCollaborationRun,
  restoreCollaborationRun,
  serializeCollaborationRun,
  transitionCollaborationRun,
  type CollaborationRun,
} from "../src/workflow/workflow.js";

const artifactHash = "f1b2c3d4-artifact-sha";
const approvalScope = "workspace-read" as const;
const handoffEvidence = {
  checkpoint: {
    artifactHash,
    headSha: "git-head-123",
    diffHash: "diff-sha-456",
    changedFiles: ["src/owned.ts"],
    testEvidence: [{ command: "npm test -- owned", exitCode: 0 }],
    sourceSessionId: "grok-session-a",
    approvals: [
      {
        approvalId: "approval-workspace-read-1",
        grantedBy: "user",
        scope: approvalScope,
        grantedAt: 1_756_000_000_000,
      },
    ],
    nextAction: {
      kind: "continue_stage" as const,
      stageId: "stage-a",
      instruction: "Continue from the verified checkpoint without widening scope",
    },
  },
  worktreeLease: {
    path: "/repo/worktree-task-9",
    leaseId: "lease-task-9-a",
    holder: "grok" as const,
    fencingToken: 7,
  },
};
const observedWorktree = {
  artifactHash,
  headSha: handoffEvidence.checkpoint.headSha,
  diffHash: handoffEvidence.checkpoint.diffHash,
  leaseId: handoffEvidence.worktreeLease.leaseId,
  fencingToken: handoffEvidence.worktreeLease.fencingToken,
};

const stage = (id: string, kind: Stage) => ({
  id,
  kind,
  role: "stage-owner" as const,
  artifactRef: `artifact://task-9/${id}`,
  artifactHash,
  artifactBytes: 1_024,
  changedFiles: 2,
  approvalScope,
  idempotencyKey: `task-9:${id}:${artifactHash}`,
});

const makeRun = (
  health: ProviderHealthSnapshot = { grok: "healthy", codex: "healthy" },
  origin: ActiveAgentId = "codex",
) =>
  createCollaborationRun({
    taskId: "task-9",
    origin,
    health,
    stages: [stage("stage-a", "planning"), stage("stage-b", "planning")],
  });

const completeCoordination = (run: CollaborationRun): CollaborationRun => {
  const coordination = run.stages[0]!;
  expect(coordination).toMatchObject({ kind: "coordination", systemGenerated: true });
  const active = transitionCollaborationRun(run, {
    type: "BEGIN_STAGE",
    stageId: coordination.id,
  });
  expect(active.activeStage?.id).toBe(coordination.id);
  return transitionCollaborationRun(active, {
    type: "COMPLETE_STAGE",
    stageId: coordination.id,
    resultHash: "coordination-result",
  });
};

const begin = (run: CollaborationRun, stageId = "stage-a") =>
  transitionCollaborationRun(completeCoordination(run), { type: "BEGIN_STAGE", stageId });

afterEach(() => vi.useRealTimers());

describe("v2 origin-neutral coordination", () => {
  it.each(["grok", "codex"] as const)(
    "inserts exactly one Codex-preferred coordination stage for %s origin",
    (origin) => {
      const run = makeRun(undefined, origin);

      expect(run.origin).toBe(origin);
      expect(run.policyVersion).toBe(ROUTING_POLICY_VERSION);
      expect(run.stages.map((item) => item.kind)).toEqual([
        "coordination",
        "planning",
        "planning",
      ]);
      expect(run.stages[0]).toMatchObject({
        systemGenerated: true,
        role: "coordinator",
        approvalScope: "workspace-read",
        artifactBytes: 1_024,
        changedFiles: 2,
      });
      expect(run.stages[0]).not.toHaveProperty("approvalReference");

      const premature = transitionCollaborationRun(run, {
        type: "BEGIN_STAGE",
        stageId: "stage-a",
      });
      expect(premature).toMatchObject({
        status: "blocked_stage_order",
        blockedReason: "coordination_required",
        activeStage: null,
      });

      const coordinated = completeCoordination(run);
      expect(coordinated.dispatches[0]?.assignment).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        policyVersion: ROUTING_POLICY_VERSION,
        reasons: ["stage_baseline:coordination:medium"],
        attemptOrdinal: 0,
      });
      const planning = transitionCollaborationRun(coordinated, {
        type: "BEGIN_STAGE",
        stageId: "stage-a",
      });
      expect(planning.activeStage?.assignment).toMatchObject({
        agent: "grok",
        model: "grok-4.6",
        effort: "medium",
        policyVersion: ROUTING_POLICY_VERSION,
        reasons: ["stage_baseline:planning:medium"],
        attemptOrdinal: 0,
      });
    },
  );

  it("does not duplicate an explicit coordination stage", () => {
    const run = createCollaborationRun({
      taskId: "explicit-coordination",
      origin: "grok",
      health: { grok: "healthy", codex: "healthy" },
      stages: [stage("coordination", "coordination")],
    });
    expect(run.stages).toHaveLength(1);
    expect(run.stages[0]?.systemGenerated).toBeUndefined();
  });
});

describe("v2 startup probing and initial fallback", () => {
  it("starts both providers as probing and computes a fresh Grok fallback decision", () => {
    const probing = createCollaborationRun({
      taskId: "startup-probe-task",
      origin: "codex",
      stages: [stage("first-coordination", "coordination")],
    });
    expect(probing.health).toEqual({ grok: "probing", codex: "probing" });

    const waiting = transitionCollaborationRun(probing, {
      type: "BEGIN_STAGE",
      stageId: "first-coordination",
    });
    expect(waiting).toMatchObject({
      status: "blocked_no_provider",
      pendingStageId: "first-coordination",
      activeStage: null,
    });

    const fallback = transitionCollaborationRun(waiting, {
      type: "STARTUP_PROBES_COMPLETED",
      eventId: "startup-probes:first-coordination",
      results: {
        grok: { health: "healthy" },
        codex: { health: "unavailable", failure: "model_mismatch" },
      },
      at: 0,
    });
    expect(fallback.activeStage?.assignment).toMatchObject({
      agent: "grok",
      model: "grok-4.6",
      effort: "xhigh",
      reasons: ["stage_baseline:coordination:high", "degraded_fallback"],
      attemptOrdinal: 0,
      degraded: true,
    });
    expect(fallback.activeStage?.assignment.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(fallback.dispatches).toHaveLength(1);
  });
});

describe("v2 per-attempt failover decisions", () => {
  it.each([
    "quota",
    "rate_limit",
    "overload",
    "network_timeout",
    "model_unavailable",
    "cli_missing",
    "auth",
  ] as const)("recomputes and persists a new decision after eligible outcome %s", (kind) => {
    const running = begin(makeRun());
    const initial = structuredClone(running.activeStage!.assignment);
    expect(initial).toMatchObject({
      agent: "grok",
      effort: "medium",
      reasons: ["stage_baseline:planning:medium"],
      attemptOrdinal: 0,
    });

    const failedOver = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: `outcome:${kind}`,
      agent: "grok",
      outcome: { kind },
      handoffEvidence,
      observedWorktree,
    });

    expect(failedOver.status).toBe("running");
    expect(failedOver.activeStage?.assignment.sessionId).not.toBe(initial.sessionId);
    expect(failedOver.activeStage).toMatchObject({
      id: "stage-a",
      role: "stage-owner",
      artifactHash,
      artifactBytes: 1_024,
      changedFiles: 2,
      approvalScope,
      assignment: {
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        policyVersion: ROUTING_POLICY_VERSION,
        reasons: [
          "stage_baseline:planning:medium",
          "degraded_fallback",
          "retry",
        ],
        attemptOrdinal: 1,
        degraded: true,
      },
    });
    expect(failedOver.failedAttempts).toEqual([
      expect.objectContaining({
        stageId: "stage-a",
        assignment: initial,
        outcome: { kind },
      }),
    ]);
    expect(failedOver.dispatches.filter((item) => item.stageId === "stage-a")).toEqual([
      expect.objectContaining({ assignment: initial }),
      expect.objectContaining({ assignment: failedOver.activeStage!.assignment }),
    ]);
    expect(failedOver.handoffs[0]).toMatchObject({
      eventId: `outcome:${kind}`,
      from: "grok",
      to: "codex",
      approvalScope,
      evidence: handoffEvidence,
      releasedLease: handoffEvidence.worktreeLease,
      acquiredLease: {
        ...handoffEvidence.worktreeLease,
        holder: "codex",
        fencingToken: 8,
      },
    });
  });

  it.each([
    "task_failure",
    "invalid_request",
    "safety_denial",
    "permission_denial",
    "user_cancelled",
  ] as const)("does not bypass terminal outcome %s", (kind) => {
    const running = begin(makeRun());
    const stopped = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: `outcome:${kind}`,
      agent: "grok",
      outcome: { kind },
      handoffEvidence,
      observedWorktree,
    });

    expect(stopped.activeStage?.assignment.agent).toBe("grok");
    expect(stopped.handoffs).toHaveLength(0);
    expect(stopped.terminalOutcome).toEqual({ kind });
  });

  it("applies the same failover event idempotently", () => {
    const event = {
      type: "PROVIDER_OUTCOME" as const,
      eventId: "outcome:one",
      agent: "grok" as const,
      outcome: { kind: "rate_limit" as const },
      handoffEvidence,
      observedWorktree,
    };
    const first = transitionCollaborationRun(begin(makeRun()), event);
    const duplicate = transitionCollaborationRun(first, event);

    expect(duplicate).toEqual(first);
    expect(duplicate.handoffs).toHaveLength(1);
    expect(duplicate.failedAttempts).toHaveLength(1);
  });

  it("preserves pinned decisions through serialization without changing prior evidence", () => {
    const running = begin(makeRun());
    const initial = structuredClone(running.activeStage!.assignment);
    const failedOver = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "outcome:serialized",
      agent: "grok",
      outcome: { kind: "overload" },
      handoffEvidence,
      observedWorktree,
    });
    const restored = restoreCollaborationRun(serializeCollaborationRun(failedOver));

    expect(restored).toEqual(failedOver);
    expect(restored.activeStage?.assignment.sessionId).toBe(failedOver.activeStage?.assignment.sessionId);
    expect(restored.policyVersion).toBe(ROUTING_POLICY_VERSION);
    expect(restored.dispatches.find((item) => item.assignment.attemptId === initial.attemptId))
      ?.toMatchObject({ assignment: initial });
    expect(restored.activeStage?.assignment.attemptId).not.toBe(initial.attemptId);
  });

  it("does not create another attempt for a repeated BEGIN_STAGE", () => {
    const running = begin(makeRun());
    const duplicate = transitionCollaborationRun(running, {
      type: "BEGIN_STAGE",
      stageId: "stage-a",
    });

    expect(duplicate).toEqual(running);
    expect(duplicate.dispatches.filter((item) => item.stageId === "stage-a"))
      .toHaveLength(1);
  });
});

describe("v2 durable blocking and recovery", () => {
  const retryPolicy = {
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    maxAttempts: 4,
  };

  const blockedPlanning = () => {
    let run = completeCoordination(makeRun());
    run = transitionCollaborationRun(run, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "grok",
      health: "unavailable",
    });
    run = transitionCollaborationRun(run, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "unavailable",
    });
    return transitionCollaborationRun(run, {
      type: "BEGIN_STAGE",
      stageId: "stage-a",
      now: 0,
    });
  };

  it("does not increment attemptOrdinal when no launch occurred", () => {
    const blocked = blockedPlanning();
    expect(blocked).toMatchObject({
      status: "blocked_no_provider",
      pendingStageId: "stage-a",
      activeStage: null,
      failedAttempts: [],
    });

    let restored = restoreCollaborationRun(serializeCollaborationRun(blocked));
    restored = transitionCollaborationRun(restored, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "healthy",
    });
    const resumed = transitionCollaborationRun(restored, {
      type: "RETRY_STAGE_BOUNDARY",
      stageId: "stage-a",
    });
    expect(resumed.activeStage?.assignment).toMatchObject({
      agent: "codex",
      effort: "high",
      reasons: ["stage_baseline:planning:medium", "degraded_fallback"],
      attemptOrdinal: 0,
    });
  });

  it("uses bounded exponential backoff and never spins before the deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let blocked = createCollaborationRun({
      ...makeRun(),
      retryPolicy,
      stages: makeRun().stages.filter((item) => !item.systemGenerated),
    });
    blocked = completeCoordination(blocked);
    blocked = transitionCollaborationRun(blocked, { type: "PROVIDER_HEALTH_CHANGED", agent: "grok", health: "unavailable" });
    blocked = transitionCollaborationRun(blocked, { type: "PROVIDER_HEALTH_CHANGED", agent: "codex", health: "unavailable" });
    blocked = transitionCollaborationRun(blocked, { type: "BEGIN_STAGE", stageId: "stage-a", now: 0 });
    expect(blocked.recovery).toMatchObject({ attempt: 0, nextRetryAt: 1_000 });

    const beforeDeadline = serializeCollaborationRun(blocked);
    for (let now = 0; now < 1_000; now += 10) {
      blocked = transitionCollaborationRun(blocked, {
        type: "RECOVERY_TIMER_FIRED",
        eventId: `early:${now}`,
        now,
      });
    }
    expect(serializeCollaborationRun(blocked)).toBe(beforeDeadline);

    const scheduledAt: number[] = [blocked.recovery!.nextRetryAt!];
    for (const now of [1_000, 3_000, 7_000, 11_000]) {
      blocked = transitionCollaborationRun(blocked, {
        type: "RECOVERY_TIMER_FIRED",
        eventId: `due:${now}`,
        now,
      });
      if (blocked.recovery?.nextRetryAt !== null) scheduledAt.push(blocked.recovery!.nextRetryAt);
    }

    const delays = scheduledAt.slice(1).map((at, index) => at - scheduledAt[index]!);
    expect(delays.every((delay) => delay <= retryPolicy.maxDelayMs)).toBe(true);
    expect(blocked).toMatchObject({
      status: "blocked_retry_exhausted",
      activeStage: null,
      recovery: { attempt: retryPolicy.maxAttempts, nextRetryAt: null },
    });

    const recoveredAfterExhaustion = transitionCollaborationRun(blocked, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "healthy",
    });
    expect(recoveredAfterExhaustion).toMatchObject({
      status: "running",
      pendingStageId: null,
      activeStage: { id: "stage-a", assignment: { agent: "codex" } },
    });
  });

  it("dispatches a recovered fallback exactly once", () => {
    let restored = blockedPlanning();
    restored = transitionCollaborationRun(restored, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "healthy",
    });
    const due = {
      type: "RECOVERY_TIMER_FIRED" as const,
      eventId: "retry:1000",
      now: 1_000,
    };
    const recovered = transitionCollaborationRun(restored, due);
    const duplicate = transitionCollaborationRun(recovered, due);

    expect(recovered.activeStage?.assignment.attemptOrdinal).toBe(0);
    expect(recovered.dispatches.filter((item) => item.stageId === "stage-a")).toHaveLength(1);
    expect(duplicate).toEqual(recovered);
  });
});

describe("v2 handoff and failback boundaries", () => {
  it("keeps the fallback owner until the next stage boundary", () => {
    const fallbackRunning = begin(makeRun({ grok: "unavailable", codex: "healthy" }));
    expect(fallbackRunning.activeStage?.assignment).toMatchObject({
      agent: "codex",
      effort: "high",
      attemptOrdinal: 0,
      degraded: true,
    });

    const preferredRecovered = transitionCollaborationRun(fallbackRunning, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "grok",
      health: "healthy",
    });
    expect(preferredRecovered.activeStage?.assignment.agent).toBe("codex");

    const completed = transitionCollaborationRun(preferredRecovered, {
      type: "COMPLETE_STAGE",
      stageId: "stage-a",
      resultHash: "result-stage-a",
    });
    const next = transitionCollaborationRun(completed, {
      type: "BEGIN_STAGE",
      stageId: "stage-b",
    });
    expect(next.activeStage?.assignment).toMatchObject({
      agent: "grok",
      model: "grok-4.6",
      effort: "medium",
      attemptOrdinal: 0,
      degraded: false,
    });
  });

  it("blocks handoff on artifact conflict", () => {
    const running = begin(makeRun());
    const conflicted = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "outcome:conflict",
      agent: "grok",
      outcome: { kind: "network_timeout" },
      handoffEvidence,
      observedWorktree: { ...observedWorktree, artifactHash: "different-worktree-sha" },
    });

    expect(conflicted).toMatchObject({
      status: "blocked_handoff_conflict",
      blockedReason: "artifact_changed_since_checkpoint",
      activeStage: { assignment: { agent: "grok" } },
      conflict: {
        checkpointHash: artifactHash,
        currentArtifactHash: "different-worktree-sha",
      },
    });
    expect(conflicted.handoffs).toHaveLength(0);
    expect(conflicted.failedAttempts).toHaveLength(1);
  });

  it("blocks handoff whose nextAction targets a different stage", () => {
    const running = begin(makeRun());
    const conflicted = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "outcome:stale-next-action",
      agent: "grok",
      outcome: { kind: "network_timeout" },
      handoffEvidence: {
        ...handoffEvidence,
        checkpoint: {
          ...handoffEvidence.checkpoint,
          nextAction: {
            ...handoffEvidence.checkpoint.nextAction,
            stageId: "stage-b",
          },
        },
      },
      observedWorktree,
    });

    expect(conflicted).toMatchObject({
      status: "blocked_handoff_conflict",
      conflict: {
        expectedStageId: "stage-a",
        checkpointStageId: "stage-b",
      },
    });
    expect(conflicted.dispatches.filter((item) => item.stageId === "stage-a"))
      .toHaveLength(1);
  });

  it("blocks handoff on lease or fencing conflict", () => {
    const running = begin(makeRun());
    const conflicted = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "outcome:lease-conflict",
      agent: "grok",
      outcome: { kind: "network_timeout" },
      handoffEvidence,
      observedWorktree: {
        ...observedWorktree,
        leaseId: "lease-held-by-someone-else",
        fencingToken: 9,
      },
    });

    expect(conflicted).toMatchObject({
      status: "blocked_handoff_conflict",
      blockedReason: "worktree_lease_conflict",
      activeStage: { assignment: { agent: "grok" } },
      conflict: {
        expectedLeaseId: "lease-task-9-a",
        observedLeaseId: "lease-held-by-someone-else",
        expectedFencingToken: 7,
        observedFencingToken: 9,
      },
    });
    expect(conflicted.handoffs).toHaveLength(0);
  });

  it("never widens role, artifact, approval or idempotency authority", () => {
    const running = begin(makeRun());
    const failedOver = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "outcome:authority",
      agent: "grok",
      outcome: { kind: "overload" },
      handoffEvidence,
      observedWorktree,
    });

    expect(failedOver.activeStage).toMatchObject({
      role: running.activeStage?.role,
      artifactRef: running.activeStage?.artifactRef,
      artifactHash: running.activeStage?.artifactHash,
      artifactBytes: running.activeStage?.artifactBytes,
      changedFiles: running.activeStage?.changedFiles,
      approvalScope: running.activeStage?.approvalScope,
      idempotencyKey: running.activeStage?.idempotencyKey,
    });
    expect(JSON.stringify(failedOver)).not.toMatch(/bypass|workspace-write|full-access/i);
  });
});
