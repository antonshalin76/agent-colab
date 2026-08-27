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
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
} from "../src/flow/map-admin.js";

const artifactHash = "f".repeat(64);
const codexLearning = createCurrentMapLearningLaunchBinding("codex");
const learningContext = formatMapLearningLaunchBindingContext(codexLearning);

const stage = (id: string, kind: Stage) => ({
  id,
  kind,
  role: "stage-owner" as const,
  artifactRef: `artifact://task-9/${id}`,
  artifactHash,
  artifactBytes: 1_024,
  changedFiles: 2,
  approvalScope: "workspace-read" as const,
  idempotencyKey: `task-9:${id}:${artifactHash}`,
  project: "/tmp/agent-collab-workflow",
  prompt: `${learningContext}\n\nexecute ${id}`,
  requester: "codex" as const,
  mapLearning: codexLearning,
});

const makeRun = (
  health: ProviderHealthSnapshot = { grok: "healthy", codex: "healthy" },
  origin: ActiveAgentId = "codex",
) => createCollaborationRun({
  taskId: "task-9",
  origin,
  health,
  stages: [stage("stage-a", "planning"), stage("stage-b", "planning")],
});

const completeCoordination = (run: CollaborationRun): CollaborationRun => {
  const coordination = run.stages[0]!;
  const active = transitionCollaborationRun(run, {
    type: "BEGIN_STAGE",
    stageId: coordination.id,
    now: 0,
    eventId: "begin:coordination",
  });
  return transitionCollaborationRun(active, {
    type: "COMPLETE_STAGE",
    stageId: coordination.id,
    resultHash: "coordination-result",
    eventId: "complete:coordination",
  });
};

const beginPlanning = (run = makeRun()): CollaborationRun =>
  transitionCollaborationRun(completeCoordination(run), {
    type: "BEGIN_STAGE",
    stageId: "stage-a",
    now: 0,
    eventId: "begin:stage-a",
  });

afterEach(() => vi.useRealTimers());

describe("routing-v5 Codex stage ownership", () => {
  it.each(["grok", "codex"] as const)(
    "inserts one Codex-owned coordination stage for %s origin",
    (origin) => {
      const run = makeRun(undefined, origin);
      expect(run.policyVersion).toBe(ROUTING_POLICY_VERSION);
      expect(run.stages.map((item) => item.kind)).toEqual([
        "coordination",
        "planning",
        "planning",
      ]);
      const coordinated = completeCoordination(run);
      expect(coordinated.dispatches[0]?.assignment).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        policyVersion: "routing-v5",
        reasons: ["stage_baseline:coordination:medium"],
        attemptOrdinal: 0,
        degraded: false,
      });
      const planning = transitionCollaborationRun(coordinated, {
        type: "BEGIN_STAGE",
        stageId: "stage-a",
        now: 1,
      });
      expect(planning.activeStage?.assignment).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        policyVersion: "routing-v5",
        reasons: ["stage_baseline:planning:medium"],
        attemptOrdinal: 0,
        degraded: false,
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

  it("does not let Grok health substitute for an unavailable Codex owner", () => {
    const run = createCollaborationRun({
      taskId: "blocked-owner",
      origin: "grok",
      health: { grok: "healthy", codex: "unavailable" },
      stages: [stage("coordination", "coordination")],
    });
    const blocked = transitionCollaborationRun(run, {
      type: "BEGIN_STAGE",
      stageId: "coordination",
      now: 0,
    });
    expect(blocked).toMatchObject({
      status: "blocked_no_provider",
      blockedReason: "codex_stage_owner_unavailable",
      pendingStageId: "coordination",
      activeStage: null,
    });
    expect(blocked.dispatches).toEqual([]);
  });

  it("ignores a Grok provider outcome for a Codex-owned attempt", () => {
    const running = beginPlanning();
    const next = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "forged:grok",
      agent: "grok",
      outcome: { kind: "network_timeout" },
      now: 10,
    });
    expect(next.activeStage).toEqual(running.activeStage);
    expect(next.failedAttempts).toEqual([]);
    expect(next.processedEventIds).toContain("forged:grok");
  });
});

describe("routing-v5 outcome and recovery boundaries", () => {
  it.each([
    "quota",
    "rate_limit",
    "overload",
    "network_timeout",
    "model_unavailable",
    "cli_missing",
    "auth",
  ] as const)("blocks the stage without cross-provider handoff after %s", (kind) => {
    const running = beginPlanning();
    const assignment = structuredClone(running.activeStage!.assignment);
    const event = {
      type: "PROVIDER_OUTCOME" as const,
      eventId: `outcome:${kind}`,
      agent: "codex" as const,
      outcome: { kind },
      now: 100,
    };
    const blocked = transitionCollaborationRun(running, event);
    const duplicate = transitionCollaborationRun(blocked, event);

    expect(blocked).toMatchObject({
      status: "blocked_no_provider",
      blockedReason: "codex_stage_owner_unavailable",
      pendingStageId: "stage-a",
      activeStage: null,
      health: { codex: "unavailable" },
      recovery: { attempt: 0, nextRetryAt: 1_100 },
    });
    expect(blocked.failedAttempts).toEqual([
      expect.objectContaining({ stageId: "stage-a", assignment, outcome: { kind } }),
    ]);
    expect(blocked.dispatches.filter((item) => item.stageId === "stage-a")).toHaveLength(1);
    expect(duplicate).toEqual(blocked);
  });

  it.each([
    "task_failure",
    "invalid_request",
    "safety_denial",
    "permission_denial",
    "user_cancelled",
  ] as const)("keeps %s terminal and never dispatches a replacement", (kind) => {
    const running = beginPlanning();
    const stopped = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: `terminal:${kind}`,
      agent: "codex",
      outcome: { kind },
      now: 100,
    });
    expect(stopped.status).toBe("terminal_outcome");
    expect(stopped.terminalOutcome).toEqual({ kind });
    expect(stopped.dispatches).toEqual(running.dispatches);
  });

  it("updates health without implicitly restarting a blocked stage", () => {
    const unavailable = makeRun({ grok: "healthy", codex: "unavailable" });
    const blocked = transitionCollaborationRun(unavailable, {
      type: "BEGIN_STAGE",
      stageId: unavailable.stages[0]!.id,
      now: 0,
    });
    const healthy = transitionCollaborationRun(blocked, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "healthy",
    });
    expect(healthy).toMatchObject({
      status: "blocked_no_provider",
      pendingStageId: unavailable.stages[0]!.id,
      activeStage: null,
    });
  });

  it("restarts exactly once after Codex is healthy and the retry deadline is due", () => {
    const run = createCollaborationRun({
      taskId: "retry-once",
      origin: "grok",
      health: { grok: "healthy", codex: "unavailable" },
      stages: [stage("coordination", "coordination")],
    });
    let blocked = transitionCollaborationRun(run, {
      type: "BEGIN_STAGE",
      stageId: "coordination",
      now: 0,
    });
    blocked = transitionCollaborationRun(blocked, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "healthy",
    });
    const due = {
      type: "RECOVERY_TIMER_FIRED" as const,
      eventId: "retry:1000",
      now: 1_000,
    };
    const recovered = transitionCollaborationRun(blocked, due);
    const duplicate = transitionCollaborationRun(recovered, due);
    expect(recovered.activeStage?.assignment).toMatchObject({
      agent: "codex",
      attemptOrdinal: 0,
    });
    expect(recovered.dispatches).toHaveLength(1);
    expect(duplicate).toEqual(recovered);
  });

  it("uses bounded exponential retry and stays blocked after exhaustion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const run = createCollaborationRun({
      taskId: "bounded-retry",
      origin: "codex",
      health: { grok: "healthy", codex: "unavailable" },
      retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 4 },
      stages: [stage("coordination", "coordination")],
    });
    let blocked = transitionCollaborationRun(run, {
      type: "BEGIN_STAGE",
      stageId: "coordination",
      now: 0,
    });
    const beforeDeadline = serializeCollaborationRun(blocked);
    for (let now = 0; now < 1_000; now += 50) {
      blocked = transitionCollaborationRun(blocked, {
        type: "RECOVERY_TIMER_FIRED",
        eventId: `early:${now}`,
        now,
      });
    }
    expect(serializeCollaborationRun(blocked)).toBe(beforeDeadline);
    for (const now of [1_000, 3_000, 7_000, 11_000]) {
      blocked = transitionCollaborationRun(blocked, {
        type: "RECOVERY_TIMER_FIRED",
        eventId: `due:${now}`,
        now,
      });
    }
    expect(blocked).toMatchObject({
      status: "blocked_retry_exhausted",
      activeStage: null,
      recovery: { attempt: 4, nextRetryAt: null },
    });
    const healthOnly = transitionCollaborationRun(blocked, {
      type: "PROVIDER_HEALTH_CHANGED",
      agent: "codex",
      health: "healthy",
    });
    expect(healthOnly.status).toBe("blocked_retry_exhausted");
    expect(healthOnly.activeStage).toBeNull();
  });
});

describe("routing-v5 persistence and stage ordering", () => {
  it("blocks ambiguous post-launch reconciliation without synthesizing provider evidence", () => {
    const running = beginPlanning();
    const blocked = transitionCollaborationRun(running, {
      type: "BROKER_RECONCILIATION_REQUIRED",
      eventId: "run-1:reconciliation-required",
      stageId: "stage-a",
      runId: "run-1",
    });
    expect(blocked).toMatchObject({
      status: "blocked_reconciliation",
      blockedReason: "runner_evidence_reconciliation_required",
      activeStage: null,
      pendingStageId: null,
      conflict: {
        kind: "runner_evidence_reconciliation_required",
        stageId: "stage-a",
        runId: "run-1",
        requiresNewWorkflowIdentity: true,
      },
    });
    expect(transitionCollaborationRun(blocked, {
      type: "BROKER_RECONCILIATION_REQUIRED",
      eventId: "run-1:reconciliation-required",
      stageId: "stage-a",
      runId: "run-1",
    })).toEqual(blocked);
  });

  it("terminalizes a broker rejection that occurs before a provider launch", () => {
    const running = beginPlanning();
    const rejected = transitionCollaborationRun(running, {
      type: "BROKER_DISPATCH_REJECTED",
      eventId: "run-2:dispatch-rejected",
      stageId: "stage-a",
      runId: "run-2",
      reason: "invalid_request",
    });
    expect(rejected).toMatchObject({
      status: "terminal_outcome",
      terminalOutcome: { kind: "invalid_request" },
      blockedReason: "broker_dispatch_rejected_before_launch",
      activeStage: null,
      conflict: {
        kind: "broker_dispatch_rejected_before_launch",
        runId: "run-2",
        reason: "invalid_request",
        requiresNewWorkflowIdentity: true,
      },
    });
  });

  it("round-trips the exact pinned assignment and failed-attempt evidence", () => {
    const running = beginPlanning();
    const blocked = transitionCollaborationRun(running, {
      type: "PROVIDER_OUTCOME",
      eventId: "serialize:failure",
      agent: "codex",
      outcome: { kind: "overload" },
      now: 10,
    });
    expect(restoreCollaborationRun(serializeCollaborationRun(blocked))).toEqual(blocked);
  });

  it("does not create another attempt for repeated BEGIN_STAGE", () => {
    const running = beginPlanning();
    const duplicate = transitionCollaborationRun(running, {
      type: "BEGIN_STAGE",
      stageId: "stage-a",
    });
    expect(duplicate).toEqual(running);
    expect(duplicate.dispatches.filter((item) => item.stageId === "stage-a")).toHaveLength(1);
  });

  it("requires coordination before planning", () => {
    const run = makeRun();
    const premature = transitionCollaborationRun(run, {
      type: "BEGIN_STAGE",
      stageId: "stage-a",
    });
    expect(premature).toMatchObject({
      status: "blocked_stage_order",
      blockedReason: "coordination_required",
      activeStage: null,
    });
  });

  it("keeps Codex ownership at every stage boundary", () => {
    const first = beginPlanning(makeRun({ grok: "unavailable", codex: "healthy" }));
    const completed = transitionCollaborationRun(first, {
      type: "COMPLETE_STAGE",
      stageId: "stage-a",
      resultHash: "stage-a-result",
    });
    const second = transitionCollaborationRun(completed, {
      type: "BEGIN_STAGE",
      stageId: "stage-b",
    });
    expect(first.activeStage?.assignment.agent).toBe("codex");
    expect(second.activeStage?.assignment.agent).toBe("codex");
    expect(second.dispatches.every(({ assignment }) => assignment.agent === "codex")).toBe(true);
  });
});
