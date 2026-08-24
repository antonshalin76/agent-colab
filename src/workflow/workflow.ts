import { createHash } from "node:crypto";
import { classifyOutcome, type ProviderOutcome } from "../domain/outcomes.js";
import {
  ROUTING_POLICY_VERSION,
  selectStageAssignment,
  type ActiveAgentId,
  type ApprovalScope,
  type EffortDecision,
  type ProviderHealth,
  type ProviderHealthSnapshot,
  type Stage,
  type StageRole,
} from "../domain/routing.js";

export interface StageDefinition {
  id: string;
  kind: Stage;
  role: StageRole;
  artifactRef: string;
  artifactHash: string;
  artifactBytes: number;
  changedFiles: number;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  systemGenerated?: boolean;
  project?: string;
  prompt?: string;
  requester?: ActiveAgentId;
  approvalReference?: string;
}

export interface AttemptAssignment extends EffortDecision {
  attemptId: string;
  attemptOrdinal: number;
  sessionId: string;
}

export interface ActiveStage extends StageDefinition {
  assignment: AttemptAssignment;
}

export interface WorktreeLeaseEvidence {
  path: string;
  leaseId: string;
  holder: ActiveAgentId;
  fencingToken: number;
}

export interface CheckpointEvidence {
  artifactHash: string;
  headSha: string;
  diffHash: string;
  changedFiles: string[];
  testEvidence: Array<{ command: string; exitCode: number }>;
  sourceSessionId: string;
  approvals: Array<{
    approvalId: string;
    grantedBy: string;
    scope: ApprovalScope;
    grantedAt: number;
  }>;
  nextAction: {
    kind: "continue_stage";
    stageId: string;
    instruction: string;
  };
}

export interface HandoffEvidence {
  checkpoint: CheckpointEvidence;
  worktreeLease: WorktreeLeaseEvidence;
}

export interface ObservedWorktree {
  artifactHash: string;
  headSha: string;
  diffHash: string;
  leaseId: string;
  fencingToken: number;
}

interface HandoffRecord {
  eventId: string;
  from: ActiveAgentId;
  to: ActiveAgentId;
  role: StageRole;
  approvalScope: ApprovalScope;
  artifactHash: string;
  idempotencyKey: string;
  evidence: HandoffEvidence;
  releasedLease: WorktreeLeaseEvidence;
  acquiredLease: WorktreeLeaseEvidence;
}

export interface DispatchRecord {
  stageId: string;
  assignment: AttemptAssignment;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
  handoffEventId?: string;
}

export interface FailedAttemptRecord {
  stageId: string;
  eventId: string;
  assignment: AttemptAssignment;
  outcome: ProviderOutcome;
}

interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

interface RecoveryState {
  attempt: number;
  nextRetryAt: number | null;
}

export interface CollaborationRun {
  taskId: string;
  origin: ActiveAgentId;
  policyVersion: typeof ROUTING_POLICY_VERSION;
  health: ProviderHealthSnapshot;
  stages: StageDefinition[];
  status:
    | "ready"
    | "probing"
    | "running"
    | "blocked_stage_order"
    | "blocked_no_provider"
    | "blocked_retry_exhausted"
    | "blocked_handoff_conflict"
    | "terminal_outcome";
  activeStage: ActiveStage | null;
  pendingStageId: string | null;
  blockedReason?: string;
  terminalOutcome?: ProviderOutcome;
  conflict?: Record<string, unknown>;
  handoffs: HandoffRecord[];
  dispatches: DispatchRecord[];
  failedAttempts: FailedAttemptRecord[];
  completedStageIds: string[];
  processedEventIds: string[];
  retryPolicy: RetryPolicy;
  recovery: RecoveryState | null;
  now: number;
}

const DEFAULT_RETRY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 5,
};

const coordinationStage = (
  taskId: string,
  first: StageDefinition,
): StageDefinition => ({
  id: `coordination:${taskId}`,
  kind: "coordination",
  role: "coordinator",
  artifactRef: first.artifactRef,
  artifactHash: first.artifactHash,
  artifactBytes: first.artifactBytes,
  changedFiles: first.changedFiles,
  approvalScope: "workspace-read",
  idempotencyKey: `${taskId}:coordination:${first.artifactHash}`,
  systemGenerated: true,
  ...(first.project ? { project: first.project } : {}),
  ...(first.requester ? { requester: first.requester } : {}),
  ...(first.prompt
    ? {
        prompt: `Coordinate the delegated ${first.kind} stage before execution. ${first.prompt}`,
      }
    : {}),
});

export function createCollaborationRun(input: {
  taskId: string;
  origin: ActiveAgentId;
  health?: ProviderHealthSnapshot;
  stages: StageDefinition[];
  retryPolicy?: RetryPolicy;
  now?: number;
}): CollaborationRun {
  if (input.stages.length === 0) {
    throw new Error("A collaboration run requires at least one stage");
  }
  const stages = input.stages.map((item) => structuredClone(item));
  if (stages[0]!.kind !== "coordination") {
    stages.unshift(coordinationStage(input.taskId, stages[0]!));
  }
  const health = input.health ?? { grok: "probing", codex: "probing" };
  return {
    taskId: input.taskId,
    origin: input.origin,
    policyVersion: ROUTING_POLICY_VERSION,
    health: structuredClone(health),
    stages,
    status: input.health === undefined ? "probing" : "ready",
    activeStage: null,
    pendingStageId: null,
    handoffs: [],
    dispatches: [],
    failedAttempts: [],
    completedStageIds: [],
    processedEventIds: [],
    retryPolicy: structuredClone(input.retryPolicy ?? DEFAULT_RETRY),
    recovery: null,
    now: input.now ?? 0,
  };
}

const cloneRun = (run: CollaborationRun): CollaborationRun => structuredClone(run);

const findStage = (run: CollaborationRun, stageId: string): StageDefinition => {
  const stage = run.stages.find((candidate) => candidate.id === stageId);
  if (stage === undefined) throw new Error(`Unknown stage: ${stageId}`);
  return stage;
};

const previousStagesComplete = (
  run: CollaborationRun,
  stageId: string,
): boolean => {
  const index = run.stages.findIndex((stage) => stage.id === stageId);
  return (
    index >= 0 &&
    run.stages
      .slice(0, index)
      .every((stage) => run.completedStageIds.includes(stage.id))
  );
};

const attemptOrdinal = (run: CollaborationRun, stageId: string): number =>
  run.failedAttempts.filter((attempt) => attempt.stageId === stageId).length;

const deterministicSessionId = (seed: string): string => {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const assignmentFor = (
  run: CollaborationRun,
  stage: StageDefinition,
): AttemptAssignment => {
  if (run.policyVersion !== ROUTING_POLICY_VERSION) {
    throw new Error(`Unsupported pinned routing policy: ${run.policyVersion}`);
  }
  const ordinal = attemptOrdinal(run, stage.id);
  const decision = selectStageAssignment({
    stage: stage.kind,
    origin: run.origin,
    health: run.health,
    trustedInputs: {
      artifactBytes: stage.artifactBytes,
      changedFiles: stage.changedFiles,
      attemptOrdinal: ordinal,
      approvalScope: stage.approvalScope,
    },
  });
  const attemptId = `${stage.id}:attempt:${ordinal}:${decision.agent}:${decision.policyVersion}`;
  return {
    ...decision,
    attemptOrdinal: ordinal,
    attemptId,
    sessionId: deterministicSessionId(`${run.taskId}:${attemptId}`),
  };
};

const dispatchRecord = (
  active: ActiveStage,
  handoffEventId?: string,
): DispatchRecord => ({
  stageId: active.id,
  assignment: structuredClone(active.assignment),
  approvalScope: active.approvalScope,
  idempotencyKey: active.idempotencyKey,
  ...(handoffEventId ? { handoffEventId } : {}),
});

const isNoProviderError = (error: unknown): boolean =>
  error instanceof Error && /no healthy provider/i.test(error.message);

const startStage = (
  run: CollaborationRun,
  stageId: string,
  now: number,
): CollaborationRun => {
  const next = cloneRun(run);
  const stage = findStage(next, stageId);
  if (next.completedStageIds.includes(stageId)) return next;
  if (next.activeStage !== null) {
    if (next.activeStage.id === stageId) return next;
    next.status = "blocked_stage_order";
    next.blockedReason = "active_stage_in_progress";
    return next;
  }
  if (!previousStagesComplete(next, stageId)) {
    next.status = "blocked_stage_order";
    next.blockedReason =
      stage.kind === "coordination"
        ? "previous_stage_required"
        : "coordination_required";
    next.activeStage = null;
    return next;
  }
  try {
    next.activeStage = { ...stage, assignment: assignmentFor(next, stage) };
    next.status = "running";
    next.pendingStageId = null;
    next.recovery = null;
    delete next.blockedReason;
    next.dispatches.push(dispatchRecord(next.activeStage));
  } catch (error) {
    if (!isNoProviderError(error)) throw error;
    next.status = "blocked_no_provider";
    next.blockedReason = "no_healthy_provider";
    next.activeStage = null;
    next.pendingStageId = stageId;
    next.recovery ??= {
      attempt: 0,
      nextRetryAt: now + next.retryPolicy.baseDelayMs,
    };
  }
  next.now = now;
  return next;
};

export type WorkflowEvent =
  | { type: "BEGIN_STAGE"; stageId: string; now?: number; eventId?: string }
  | {
      type: "RETRY_STAGE_BOUNDARY";
      stageId: string;
      now?: number;
      eventId?: string;
    }
  | {
      type: "COMPLETE_STAGE";
      stageId: string;
      resultHash: string;
      eventId?: string;
    }
  | {
      type: "PROVIDER_HEALTH_CHANGED";
      agent: ActiveAgentId;
      health: ProviderHealth;
    }
  | {
      type: "STARTUP_PROBES_COMPLETED";
      eventId: string;
      results: Record<
        ActiveAgentId,
        { health: ProviderHealth; failure?: string; failures?: string[] }
      >;
      at: number;
    }
  | { type: "RECOVERY_TIMER_FIRED"; eventId: string; now: number }
  | {
      type: "HANDOFF_TRANSFER_CONFLICT";
      eventId: string;
      stageId: string;
      expectedFencingToken: number;
      currentFencingToken: number;
    }
  | {
      type: "PROVIDER_OUTCOME";
      eventId: string;
      agent: ActiveAgentId;
      outcome: ProviderOutcome;
      handoffEvidence: HandoffEvidence;
      observedWorktree: ObservedWorktree;
      now?: number;
    };

const alreadyProcessed = (
  run: CollaborationRun,
  event: WorkflowEvent,
): boolean =>
  "eventId" in event &&
  typeof event.eventId === "string" &&
  run.processedEventIds.includes(event.eventId);

const markProcessed = (run: CollaborationRun, event: WorkflowEvent): void => {
  if ("eventId" in event && typeof event.eventId === "string") {
    run.processedEventIds.push(event.eventId);
  }
};

const recordFailedAttempt = (
  run: CollaborationRun,
  event: Extract<WorkflowEvent, { type: "PROVIDER_OUTCOME" }>,
): void => {
  const active = run.activeStage;
  if (
    active === null ||
    run.failedAttempts.some(
      (attempt) => attempt.assignment.attemptId === active.assignment.attemptId,
    )
  ) {
    return;
  }
  run.failedAttempts.push({
    stageId: active.id,
    eventId: event.eventId,
    assignment: structuredClone(active.assignment),
    outcome: structuredClone(event.outcome),
  });
};

export function transitionCollaborationRun(
  run: CollaborationRun,
  event: WorkflowEvent,
): CollaborationRun {
  if (alreadyProcessed(run, event)) return run;

  if (event.type === "BEGIN_STAGE" || event.type === "RETRY_STAGE_BOUNDARY") {
    const next = startStage(run, event.stageId, event.now ?? run.now);
    markProcessed(next, event);
    return next;
  }

  if (event.type === "PROVIDER_HEALTH_CHANGED") {
    const next = cloneRun(run);
    next.health[event.agent] = event.health;
    if (
      event.health === "healthy" &&
      next.pendingStageId !== null &&
      next.activeStage === null
    ) {
      return startStage(next, next.pendingStageId, next.now);
    }
    return next;
  }

  if (event.type === "COMPLETE_STAGE") {
    const next = cloneRun(run);
    if (next.activeStage?.id !== event.stageId) {
      throw new Error("Cannot complete an inactive stage");
    }
    if (!next.completedStageIds.includes(event.stageId)) {
      next.completedStageIds.push(event.stageId);
    }
    next.activeStage = null;
    next.pendingStageId = null;
    next.recovery = null;
    next.status = "ready";
    markProcessed(next, event);
    return next;
  }

  if (event.type === "STARTUP_PROBES_COMPLETED") {
    const next = cloneRun(run);
    next.health.grok = event.results.grok.health;
    next.health.codex = event.results.codex.health;
    next.now = event.at;
    markProcessed(next, event);
    return next.pendingStageId === null
      ? next
      : startStage(next, next.pendingStageId, event.at);
  }

  if (event.type === "RECOVERY_TIMER_FIRED") {
    if (
      run.recovery === null ||
      run.recovery.nextRetryAt === null ||
      event.now < run.recovery.nextRetryAt ||
      run.status === "blocked_retry_exhausted"
    ) {
      return run;
    }
    const next = cloneRun(run);
    markProcessed(next, event);
    if (
      next.pendingStageId !== null &&
      Object.values(next.health).includes("healthy")
    ) {
      return startStage(next, next.pendingStageId, event.now);
    }
    const attempt = next.recovery!.attempt + 1;
    next.recovery!.attempt = attempt;
    next.now = event.now;
    if (attempt >= next.retryPolicy.maxAttempts) {
      next.recovery!.nextRetryAt = null;
      next.status = "blocked_retry_exhausted";
      return next;
    }
    const delay = Math.min(
      next.retryPolicy.baseDelayMs * 2 ** attempt,
      next.retryPolicy.maxDelayMs,
    );
    next.recovery!.nextRetryAt = event.now + delay;
    return next;
  }

  if (event.type === "HANDOFF_TRANSFER_CONFLICT") {
    const next = cloneRun(run);
    if (next.activeStage?.id !== event.stageId) return next;
    next.status = "blocked_handoff_conflict";
    next.blockedReason = "worktree_lease_transfer_fenced";
    next.conflict = {
      kind: "worktree_lease_transfer_fenced",
      stageId: event.stageId,
      expectedFencingToken: event.expectedFencingToken,
      currentFencingToken: event.currentFencingToken,
    };
    next.activeStage = null;
    markProcessed(next, event);
    return next;
  }

  const next = cloneRun(run);
  markProcessed(next, event);
  if (
    next.activeStage === null ||
    next.activeStage.assignment.agent !== event.agent
  ) {
    return next;
  }
  const outcomePolicy = classifyOutcome(event.outcome);
  if (!outcomePolicy.failoverEligible) {
    next.status = "terminal_outcome";
    next.terminalOutcome = structuredClone(event.outcome);
    return next;
  }

  const evidence = event.handoffEvidence;
  const observed = event.observedWorktree;
  const previous = next.activeStage.assignment.agent;
  recordFailedAttempt(next, event);
  next.health[event.agent] = "unavailable";
  next.now = event.now ?? next.now;
  if (
    evidence.checkpoint.artifactHash !== next.activeStage.artifactHash ||
    evidence.checkpoint.artifactHash !== observed.artifactHash ||
    evidence.checkpoint.nextAction.stageId !== next.activeStage.id
  ) {
    next.status = "blocked_handoff_conflict";
    next.blockedReason = "artifact_changed_since_checkpoint";
    next.conflict = {
      kind: "artifact_hash_mismatch",
      activeArtifactHash: next.activeStage.artifactHash,
      checkpointHash: evidence.checkpoint.artifactHash,
      currentArtifactHash: observed.artifactHash,
      expectedStageId: next.activeStage.id,
      checkpointStageId: evidence.checkpoint.nextAction.stageId,
    };
    return next;
  }
  if (
    evidence.worktreeLease.leaseId !== observed.leaseId ||
    evidence.worktreeLease.fencingToken !== observed.fencingToken ||
    evidence.worktreeLease.holder !== previous
  ) {
    next.status = "blocked_handoff_conflict";
    next.blockedReason = "worktree_lease_conflict";
    next.conflict = {
      kind: "worktree_lease_mismatch",
      expectedLeaseId: evidence.worktreeLease.leaseId,
      observedLeaseId: observed.leaseId,
      expectedFencingToken: evidence.worktreeLease.fencingToken,
      observedFencingToken: observed.fencingToken,
      expectedHolder: previous,
      observedHolder: evidence.worktreeLease.holder,
    };
    return next;
  }

  let assignment: AttemptAssignment;
  try {
    assignment = assignmentFor(next, next.activeStage);
  } catch (error) {
    if (!isNoProviderError(error)) throw error;
    next.status = "blocked_no_provider";
    next.blockedReason = "no_healthy_provider";
    next.pendingStageId = next.activeStage.id;
    next.activeStage = null;
    next.recovery = {
      attempt: 0,
      nextRetryAt: next.now + next.retryPolicy.baseDelayMs,
    };
    return next;
  }

  const releasedLease = structuredClone(evidence.worktreeLease);
  const acquiredLease: WorktreeLeaseEvidence = {
    ...releasedLease,
    holder: assignment.agent,
    fencingToken: releasedLease.fencingToken + 1,
  };
  next.activeStage.assignment = assignment;
  next.handoffs.push({
    eventId: event.eventId,
    from: previous,
    to: assignment.agent,
    role: next.activeStage.role,
    approvalScope: next.activeStage.approvalScope,
    artifactHash: next.activeStage.artifactHash,
    idempotencyKey: next.activeStage.idempotencyKey,
    evidence: structuredClone(evidence),
    releasedLease,
    acquiredLease,
  });
  next.dispatches.push(dispatchRecord(next.activeStage, event.eventId));
  next.status = "running";
  next.pendingStageId = null;
  next.recovery = null;
  delete next.blockedReason;
  return next;
}

export const serializeCollaborationRun = (run: CollaborationRun): string =>
  JSON.stringify(run);

export const restoreCollaborationRun = (
  serialized: string,
): CollaborationRun => JSON.parse(serialized) as CollaborationRun;
