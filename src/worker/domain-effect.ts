import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { FAILOVER_OUTCOMES, TERMINAL_OUTCOMES, isFailoverOutcome } from "../domain/outcomes.js";
import {
  PrelaunchOutcomeReceiptSchema,
  RunnerOutcomeReceiptSchema,
} from "../runtime/collaboration-runtime.js";
import type { RunRecord } from "../store/run-store.js";

const OutcomeKindSchema = z.enum([...FAILOVER_OUTCOMES, ...TERMINAL_OUTCOMES]);
const ResultKindSchema = z.enum(["success", ...FAILOVER_OUTCOMES, ...TERMINAL_OUTCOMES]);
const TerminalAtSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const LeaseSchema = z.object({
  worktreePath: z.string().min(1),
  taskId: z.string().min(1),
  leaseId: z.uuid(),
  holder: z.enum(["grok", "codex"]),
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const AssignmentSchema = z.object({
  agent: z.literal("codex"),
  model: z.literal("gpt-5.6-sol"),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  policyVersion: z.literal("routing-v5"),
  reasons: z.array(z.string().min(1)).min(1),
  degraded: z.boolean(),
  attemptId: z.string().min(1),
  attemptOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sessionId: z.uuid(),
}).strict();

export const PersistedDomainEffectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workflow_reconciliation_block"),
    workflowId: z.string().min(1),
    stageId: z.string().min(1),
    runId: z.uuid(),
    lease: LeaseSchema.optional(),
    terminalAt: TerminalAtSchema,
  }).strict(),
  z.object({
    type: z.literal("workflow_dispatch_rejected"),
    workflowId: z.string().min(1),
    stageId: z.string().min(1),
    runId: z.uuid(),
    reason: OutcomeKindSchema,
    prelaunchReceipt: PrelaunchOutcomeReceiptSchema,
    lease: LeaseSchema.optional(),
    terminalAt: TerminalAtSchema,
  }).strict(),
  z.object({
    type: z.literal("workflow"),
    workflowId: z.string().min(1),
    stageId: z.string().min(1),
    assignment: AssignmentSchema,
    agent: z.literal("codex"),
    resultKind: ResultKindSchema,
    runnerReceipt: RunnerOutcomeReceiptSchema,
    lease: LeaseSchema.optional(),
    terminalAt: TerminalAtSchema,
  }).strict(),
  z.object({
    type: z.literal("review"),
    reviewId: z.string().min(1),
    attemptId: z.uuid(),
    role: z.enum(["auditor", "critic"]),
    agent: z.enum(["grok", "claude", "codex"]),
    resultKind: ResultKindSchema,
    terminalAt: TerminalAtSchema,
  }).strict(),
]);

export type PersistedDomainEffect = z.infer<typeof PersistedDomainEffectSchema>;

export function parsePersistedDomainEffect(input: unknown): PersistedDomainEffect {
  const parsed = PersistedDomainEffectSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`invalid persisted domain-effect schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`persisted domain effect conflicts with immutable ${label}`);
  }
}

function assertRecordedLease(run: RunRecord, effect: PersistedDomainEffect): void {
  if (effect.type === "review") return;
  const launch = object(run.launchInfo);
  const executionContext = object(launch?.executionContext);
  requireEqual(effect.lease, object(executionContext?.lease) ?? undefined, "execution lease");
}

export function assertPersistedDomainEffectMatchesRun(
  run: RunRecord,
  providerResult: Readonly<Record<string, unknown>>,
  effect: PersistedDomainEffect,
): void {
  const payload = object(run.payload);
  if (!payload) throw new Error("persisted domain effect has no immutable run payload");
  const resultKind = providerResult.kind;
  const expectedRunStatus = resultKind === "success" || isFailoverOutcome(resultKind) ? "completed" : "failed";
  requireEqual(run.status, expectedRunStatus, "outer run status");
  assertRecordedLease(run, effect);

  if (effect.type === "review") {
    requireEqual(run.stage, `review:${effect.role}`, "review stage");
    requireEqual(effect.reviewId, payload.reviewId, "review id");
    requireEqual(effect.attemptId, payload.reviewAttemptId, "review attempt id");
    requireEqual(effect.role, payload.reviewRole, "review role");
    requireEqual(effect.agent, object(payload.decision)?.agent, "review agent");
    requireEqual(effect.resultKind, providerResult.kind, "provider result kind");
    requireEqual(providerResult.agent, effect.agent, "provider result agent");
    return;
  }

  requireEqual(effect.workflowId, payload.workflowId, "workflow id");
  requireEqual(effect.stageId, payload.workflowStageId, "workflow stage id");

  if (effect.type === "workflow_reconciliation_block") {
    requireEqual(effect.runId, run.id, "run id");
    requireEqual(providerResult.kind, "task_failure", "reconciliation result kind");
    return;
  }

  if (effect.type === "workflow_dispatch_rejected") {
    requireEqual(effect.reason, providerResult.kind, "provider result kind");
    requireEqual(effect.runId, run.id, "run id");
    requireEqual(effect.reason, effect.prelaunchReceipt.resultKind, "prelaunch reason");
    requireEqual(effect.prelaunchReceipt, {
      schemaVersion: "prelaunch-outcome/v1",
      runId: run.id,
      runAttemptCount: run.attemptCount,
      dispatchId: run.idempotencyKey,
      workflowId: effect.workflowId,
      stageId: effect.stageId,
      attemptId: object(payload.workflowDispatchIdentity)?.attemptId,
      attemptOrdinal: object(payload.workflowDispatchIdentity)?.attemptOrdinal,
      agent: object(payload.workflowDispatchIdentity)?.agent,
      model: object(payload.workflowDispatchIdentity)?.model,
      policyVersion: object(payload.workflowDispatchIdentity)?.policyVersion,
      sessionId: object(payload.workflowDispatchIdentity)?.sessionId,
      resultKind: effect.reason,
    }, "prelaunch receipt");
    requireEqual(providerResult.agent, object(payload.workflowDispatchIdentity)?.agent,
      "provider result agent");
    return;
  }

  requireEqual(effect.resultKind, providerResult.kind, "provider result kind");
  const assignment = object(payload.workflowDispatchIdentity);
  requireEqual(effect.assignment, assignment, "workflow assignment");
  requireEqual(effect.agent, assignment?.agent, "workflow agent");
  requireEqual(providerResult.agent, effect.agent, "provider result agent");
  requireEqual(effect.runnerReceipt, {
    schemaVersion: "runner-outcome/v1",
    runId: run.id,
    runAttemptCount: run.attemptCount,
    dispatchId: run.idempotencyKey,
    workflowId: effect.workflowId,
    stageId: effect.stageId,
    attemptId: assignment?.attemptId,
    attemptOrdinal: assignment?.attemptOrdinal,
    agent: assignment?.agent,
    model: assignment?.model,
    policyVersion: assignment?.policyVersion,
    sessionId: assignment?.sessionId,
    resultKind: effect.resultKind,
  }, "runner receipt");
}

export function isTransientSqliteError(error: unknown): boolean {
  return /database is (?:busy|locked)|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error));
}
