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
import type { MapLearningLaunchBinding } from "../flow/map-admin.js";
import type { ExecutionSnapshotBinding } from "../flow/execution-snapshot.js";

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
  sourceFingerprint?: string;
  authorizationConsumerKey?: string;
  mapLearning: MapLearningLaunchBinding;
  executionSnapshot?: ExecutionSnapshotBinding;
}

export interface AttemptAssignment extends EffortDecision {
  attemptId: string;
  attemptOrdinal: number;
  sessionId: string;
}

export type PersistedRoutingPolicyVersion =
  | "routing-v2"
  | "routing-v3"
  | typeof ROUTING_POLICY_VERSION;

export interface ActiveStage extends StageDefinition {
  assignment: AttemptAssignment;
}

export interface DispatchRecord {
  stageId: string;
  assignment: AttemptAssignment;
  approvalScope: ApprovalScope;
  idempotencyKey: string;
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
  policyVersion: PersistedRoutingPolicyVersion;
  health: ProviderHealthSnapshot;
  stages: StageDefinition[];
  status:
    | "ready"
    | "probing"
    | "running"
    | "blocked_stage_order"
    | "blocked_no_provider"
    | "blocked_retry_exhausted"
    | "blocked_policy_upgrade"
    | "blocked_reconciliation"
    | "terminal_outcome";
  activeStage: ActiveStage | null;
  pendingStageId: string | null;
  blockedReason?: string;
  terminalOutcome?: ProviderOutcome;
  conflict?: Record<string, unknown>;
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
  ...(first.sourceFingerprint ? { sourceFingerprint: first.sourceFingerprint } : {}),
  mapLearning: structuredClone(first.mapLearning),
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
  if (input.stages.some((stage) => stage.mapLearning === undefined)) {
    throw new Error("Every collaboration stage requires an exact durable MAP learning snapshot");
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

const dispatchRecord = (active: ActiveStage): DispatchRecord => ({
  stageId: active.id,
  assignment: structuredClone(active.assignment),
  approvalScope: active.approvalScope,
  idempotencyKey: active.idempotencyKey,
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
    next.blockedReason = "codex_stage_owner_unavailable";
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
      type: "BROKER_RECONCILIATION_REQUIRED";
      eventId: string;
      stageId: string;
      runId: string;
    }
  | {
      type: "BROKER_DISPATCH_REJECTED";
      eventId: string;
      stageId: string;
      runId: string;
      reason: string;
    }
  | {
      type: "PROVIDER_OUTCOME";
      eventId: string;
      agent: ActiveAgentId;
      outcome: ProviderOutcome;
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
  if (run.policyVersion !== ROUTING_POLICY_VERSION) {
    return blockLegacyPolicyRun(run);
  }
  if (alreadyProcessed(run, event)) return run;

  if (event.type === "BEGIN_STAGE" || event.type === "RETRY_STAGE_BOUNDARY") {
    const next = startStage(run, event.stageId, event.now ?? run.now);
    markProcessed(next, event);
    return next;
  }

  if (event.type === "PROVIDER_HEALTH_CHANGED") {
    const next = cloneRun(run);
    next.health[event.agent] = event.health;
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
    return next;
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
      next.health.codex === "healthy"
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

  if (event.type === "BROKER_RECONCILIATION_REQUIRED") {
    const next = cloneRun(run);
    if (next.activeStage?.id !== event.stageId) return next;
    next.status = "blocked_reconciliation";
    next.blockedReason = "runner_evidence_reconciliation_required";
    next.conflict = {
      kind: "runner_evidence_reconciliation_required",
      stageId: event.stageId,
      runId: event.runId,
      requiresNewWorkflowIdentity: true,
    };
    next.activeStage = null;
    next.pendingStageId = null;
    next.recovery = null;
    markProcessed(next, event);
    return next;
  }

  if (event.type === "BROKER_DISPATCH_REJECTED") {
    const next = cloneRun(run);
    if (next.activeStage?.id !== event.stageId) return next;
    next.status = "terminal_outcome";
    next.terminalOutcome = { kind: "invalid_request" };
    next.blockedReason = "broker_dispatch_rejected_before_launch";
    next.conflict = {
      kind: "broker_dispatch_rejected_before_launch",
      stageId: event.stageId,
      runId: event.runId,
      reason: event.reason,
      requiresNewWorkflowIdentity: true,
    };
    next.activeStage = null;
    next.pendingStageId = null;
    next.recovery = null;
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

  const previous = next.activeStage.assignment.agent;
  recordFailedAttempt(next, event);
  next.health[event.agent] = "unavailable";
  next.now = event.now ?? next.now;
  if (previous !== "codex") {
    next.status = "terminal_outcome";
    next.terminalOutcome = { kind: "invalid_request" };
    return next;
  }
  next.status = "blocked_no_provider";
  next.blockedReason = "codex_stage_owner_unavailable";
  next.pendingStageId = next.activeStage.id;
  next.activeStage = null;
  next.recovery = {
    attempt: 0,
    nextRetryAt: next.now + next.retryPolicy.baseDelayMs,
  };
  return next;
}

export const serializeCollaborationRun = (run: CollaborationRun): string =>
  JSON.stringify(run);

export const blockLegacyPolicyRun = (run: CollaborationRun): CollaborationRun => {
  if (run.policyVersion === ROUTING_POLICY_VERSION) return run;
  if (run.policyVersion !== "routing-v2" && run.policyVersion !== "routing-v3") {
    throw new Error(`Unsupported persisted routing policy: ${String(run.policyVersion)}`);
  }
  if (run.completedStageIds.length >= run.stages.length) return run;
  return {
    ...cloneRun(run),
    status: "blocked_policy_upgrade",
    blockedReason: "routing_policy_upgrade_requires_replan",
    activeStage: null,
    pendingStageId: null,
    recovery: null,
    conflict: {
      kind: "routing_policy_upgrade",
      from: run.policyVersion,
      to: ROUTING_POLICY_VERSION,
      requiresNewWorkflowIdentity: true,
    },
  };
};

export const restoreCollaborationRun = (
  serialized: string,
): CollaborationRun => blockLegacyPolicyRun(JSON.parse(serialized) as CollaborationRun);
