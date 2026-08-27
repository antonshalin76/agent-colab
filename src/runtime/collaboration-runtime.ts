import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { z } from "zod";
import { FAILOVER_OUTCOMES, TERMINAL_OUTCOMES, isFailoverOutcome } from "../domain/outcomes.js";
import type {
  ActiveAgentId,
  EffortDecision,
  ProviderHealth,
} from "../domain/routing.js";
import { sanitizeResult } from "../security/redaction.js";
import { CollaborationRunStore } from "../store/collaboration-run-store.js";
import { RunStore, type RunRecord } from "../store/run-store.js";
import type {
  ActiveStage,
  AttemptAssignment,
  CollaborationRun,
} from "../workflow/workflow.js";
import { RunGateUnitOfWork } from "./run-gate-unit-of-work.js";
import type { MapAdmissionProof } from "../flow/map-admission.js";
import { ApprovalLedger } from "../security/approval-ledger.js";
import { ExecutionAdmission } from "./execution-admission.js";

export type DispatchDisposition =
  | "execute"
  | "completed"
  | "superseded"
  | "terminal";

export const RunnerOutcomeReceiptSchema = z.object({
  schemaVersion: z.literal("runner-outcome/v1"),
  runId: z.uuid(),
  runAttemptCount: z.number().int().positive(),
  dispatchId: z.string().min(1),
  workflowId: z.string().min(1),
  stageId: z.string().min(1),
  attemptId: z.string().min(1),
  attemptOrdinal: z.number().int().nonnegative(),
  agent: z.literal("codex"),
  model: z.literal("gpt-5.6-sol"),
  policyVersion: z.literal("routing-v4"),
  sessionId: z.uuid(),
  resultKind: z.enum(["success", ...FAILOVER_OUTCOMES, ...TERMINAL_OUTCOMES]),
}).strict();

export const PrelaunchOutcomeReceiptSchema = RunnerOutcomeReceiptSchema.omit({
  schemaVersion: true,
}).extend({
  schemaVersion: z.literal("prelaunch-outcome/v1"),
  resultKind: z.enum([...FAILOVER_OUTCOMES, ...TERMINAL_OUTCOMES]),
}).strict();

export type RunnerOutcomeReceipt = z.infer<typeof RunnerOutcomeReceiptSchema>;

export class RunnerOutcomeEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerOutcomeEvidenceError";
  }
}

function invalidRunnerOutcomeEvidence(message: string): never {
  throw new RunnerOutcomeEvidenceError(message);
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const effortDecision = (assignment: AttemptAssignment): EffortDecision => ({
  agent: assignment.agent,
  model: assignment.model,
  effort: assignment.effort,
  policyVersion: assignment.policyVersion,
  reasons: structuredClone(assignment.reasons),
  degraded: assignment.degraded,
});

export class CollaborationRuntime {
  readonly workflows: Readonly<Pick<CollaborationRunStore, "get" | "recoverable" | "pendingDispatches">>;
  private readonly workflowStore: CollaborationRunStore;
  private readonly reviews: RunGateUnitOfWork;
  private readonly approvals: ApprovalLedger;
  private readonly admission: ExecutionAdmission;
  private readonly db: Database.Database;
  private readonly databasePath: string;

  constructor(path: string) {
    this.databasePath = path;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.workflowStore = new CollaborationRunStore(this.db);
    this.workflows = Object.freeze({
      get: (workflowId: string) => this.workflowStore.get(workflowId),
      recoverable: () => this.workflowStore.recoverable(),
      pendingDispatches: () => this.workflowStore.pendingDispatches(),
    });
    this.reviews = new RunGateUnitOfWork(this.db);
    this.approvals = new ApprovalLedger(this.db);
    this.admission = new ExecutionAdmission(this.db, this.workflowStore, this.reviews, this.approvals);
  }

  createAndStart(
    workflowId: string,
    run: CollaborationRun,
    mapAdmissionsOrNow: readonly MapAdmissionProof[] | number = [],
    explicitNow = Date.now(),
    approvalReference?: string,
  ): CollaborationRun {
    const mapAdmissions = Array.isArray(mapAdmissionsOrNow) ? mapAdmissionsOrNow : [];
    const now = typeof mapAdmissionsOrNow === "number" ? mapAdmissionsOrNow : explicitNow;
    const admittedRun = this.admission.prepareCandidate(workflowId, run);
    return this.admission.startAdmittedWorkflow({ workflowId, run: admittedRun, proofs: mapAdmissions,
      ...(approvalReference ? { approvalReference } : {}),
      event: {
        type: "BEGIN_STAGE",
        stageId: run.stages[0]!.id,
        now,
        eventId: `${workflowId}:begin:0`,
      },
      now });
  }

  prepareCandidate(workflowId: string, run: CollaborationRun): CollaborationRun {
    return this.admission.prepareCandidate(workflowId, run);
  }

  reviewTarget(run: CollaborationRun, stageId: string) {
    const bytes = this.admission.snapshotBytes(run, stageId);
    const stage = run.stages.find(({ id }) => id === stageId);
    if (!stage?.executionSnapshot) throw new Error(`execution snapshot is missing for stage: ${stageId}`);
    return { bytes, binding: structuredClone(stage.executionSnapshot) };
  }

  dispatchDisposition(
    workflowId: string,
    stageId: string,
    queuedAssignment: AttemptAssignment,
  ): DispatchDisposition {
    const state = this.workflowStore.get(workflowId);
    if (!state) return "terminal";
    if (state.completedStageIds.includes(stageId)) return "completed";
    if (
      state.status === "terminal_outcome" ||
      state.status === "blocked_retry_exhausted" ||
      state.status === "blocked_policy_upgrade" ||
      state.status === "blocked_reconciliation"
    ) {
      return "terminal";
    }
    if (
      state.activeStage?.id !== stageId ||
      state.status !== "running" ||
      state.failedAttempts.some(
        (attempt) =>
          attempt.assignment.attemptId === queuedAssignment.attemptId,
      ) ||
      !isDeepStrictEqual(state.activeStage.assignment, queuedAssignment)
    ) {
      return "superseded";
    }
    return "execute";
  }

  private completeStage(
    workflowId: string,
    stageId: string,
    assignment: AttemptAssignment,
    result: unknown,
    now = Date.now(),
  ): CollaborationRun {
    const current = this.workflowStore.get(workflowId);
    if (!current) {
      throw new Error(`Unknown collaboration workflow: ${workflowId}`);
    }
    if (current.completedStageIds.includes(stageId)) return current;
    if (
      current.status !== "running" ||
      current.activeStage?.id !== stageId ||
      !isDeepStrictEqual(current.activeStage.assignment, assignment)
    ) {
      throw new Error("stale workflow assignment cannot complete the active stage");
    }
    const resultHash = createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex");
    const nextStage = current.stages.find(
      (stage) =>
        stage.id !== stageId &&
        !current.completedStageIds.includes(stage.id),
    );
    return this.workflowStore.applyMany(
      workflowId,
      [
        {
          type: "COMPLETE_STAGE",
          stageId,
          resultHash,
          eventId: `${workflowId}:complete:${stageId}:${resultHash}`,
        },
        ...(nextStage
          ? [
              {
                type: "BEGIN_STAGE" as const,
                stageId: nextStage.id,
                now,
                eventId: `${workflowId}:begin:${nextStage.id}`,
              },
            ]
          : []),
      ],
      now,
    );
  }

  recordRunnerOutcome(
    workflowId: string,
    input: unknown,
    now = Date.now(),
  ): CollaborationRun {
    const parsed = RunnerOutcomeReceiptSchema.safeParse(input);
    if (!parsed.success) {
      invalidRunnerOutcomeEvidence(`invalid runner receipt: ${parsed.error.message}`);
    }
    const receipt = parsed.data;
    if (receipt.workflowId !== workflowId) {
      invalidRunnerOutcomeEvidence("runner receipt workflow mismatch");
    }
    const current = this.workflowStore.get(workflowId);
    const active = current?.activeStage;
    if (!active || current.status !== "running") {
      invalidRunnerOutcomeEvidence(`runner receipt has no active workflow stage: ${workflowId}`);
    }
    const expectedIdentity = active.assignment;
    const dispatchIndex = current.dispatches.findIndex(
      (dispatch) =>
        dispatch.stageId === active.id &&
        isDeepStrictEqual(dispatch.assignment, expectedIdentity),
    );
    if (dispatchIndex < 0) {
      invalidRunnerOutcomeEvidence("active attempt has no canonical dispatch");
    }
    const expectedDispatchId = `${workflowId}:dispatch:${dispatchIndex}`;
    if (
      receipt.dispatchId !== expectedDispatchId ||
      receipt.stageId !== active.id ||
      receipt.attemptId !== expectedIdentity.attemptId ||
      receipt.attemptOrdinal !== expectedIdentity.attemptOrdinal ||
      receipt.agent !== expectedIdentity.agent ||
      receipt.model !== expectedIdentity.model ||
      receipt.policyVersion !== expectedIdentity.policyVersion ||
      receipt.sessionId !== expectedIdentity.sessionId
    ) {
      invalidRunnerOutcomeEvidence("runner receipt does not match the active attempt identity");
    }

    const runs = new RunStore(this.databasePath);
    let run: RunRecord | undefined;
    try {
      run = runs.get(receipt.runId);
    } finally {
      runs.close();
    }
    if (
      !run ||
      !run.launched ||
      run.attemptCount !== receipt.runAttemptCount ||
      run.idempotencyKey !== receipt.dispatchId
    ) {
      invalidRunnerOutcomeEvidence("runner receipt does not match a launched durable run");
    }
    const launch = asObject(run.launchInfo);
    if (
      launch?.phase !== "started" ||
      !Number.isSafeInteger(launch.pid) ||
      Number(launch.pid) <= 0 ||
      launch.agent !== expectedIdentity.agent ||
      launch.model !== expectedIdentity.model ||
      launch.effort !== expectedIdentity.effort ||
      launch.policyVersion !== expectedIdentity.policyVersion ||
      launch.sessionId !== expectedIdentity.sessionId
    ) {
      invalidRunnerOutcomeEvidence("runner receipt does not match exact durable launch evidence");
    }
    const expectedStatus = receipt.resultKind === "success" || isFailoverOutcome(receipt.resultKind)
      ? "completed" : "failed";
    if (run.status !== expectedStatus) {
      invalidRunnerOutcomeEvidence("runner receipt lifecycle status mismatch");
    }
    const payload = run.payload ?? {};
    if (
      payload.workflowId !== workflowId ||
      payload.workflowStageId !== active.id ||
      payload.workflowDispatchId !== receipt.dispatchId ||
      !isDeepStrictEqual(payload.workflowDispatchIdentity, expectedIdentity)
    ) {
      invalidRunnerOutcomeEvidence("runner receipt queue payload mismatch");
    }
    const envelope = asObject(run.result);
    const providerResult = asObject(envelope?.providerResult);
    const effect = asObject(envelope?.effect);
    if (
      (envelope?.domainEffect !== "pending" && envelope?.domainEffect !== "applying" &&
        envelope?.domainEffect !== "applied") ||
      providerResult?.kind !== receipt.resultKind ||
      providerResult?.agent !== receipt.agent ||
      effect?.type !== "workflow" ||
      effect?.workflowId !== workflowId ||
      effect?.stageId !== active.id ||
      effect?.resultKind !== receipt.resultKind ||
      !isDeepStrictEqual(effect?.assignment, expectedIdentity) ||
      !isDeepStrictEqual(effect?.runnerReceipt, receipt)
    ) {
      invalidRunnerOutcomeEvidence("runner receipt does not match persisted broker evidence");
    }
    if (receipt.resultKind === "success") {
      return this.completeStage(
        workflowId,
        active.id,
        active.assignment,
        providerResult,
        now,
      );
    }
    return this.workflowStore.apply(
      workflowId,
      {
        type: "PROVIDER_OUTCOME",
        eventId: `${receipt.runId}:${receipt.runAttemptCount}:${receipt.resultKind}`,
        agent: receipt.agent,
        outcome: { kind: receipt.resultKind },
        now,
      },
      now,
    );
  }

  recordProviderHealth(
    workflowId: string,
    agent: ActiveAgentId,
    health: ProviderHealth,
    now = Date.now(),
  ): CollaborationRun {
    return this.workflowStore.apply(
      workflowId,
      { type: "PROVIDER_HEALTH_CHANGED", agent, health },
      now,
    );
  }

  retryBlockedStage(workflowId: string, now = Date.now()): CollaborationRun {
    const current = this.workflowStore.get(workflowId);
    if (!current?.recovery || current.pendingStageId === null) {
      throw new Error("workflow is not awaiting a broker-controlled retry");
    }
    return this.workflowStore.apply(
      workflowId,
      {
        type: "RECOVERY_TIMER_FIRED",
        eventId: `${workflowId}:retry:${current.recovery.attempt}:${current.recovery.nextRetryAt}`,
        now,
      },
      now,
    );
  }

  blockRunnerReconciliation(
    workflowId: string,
    stageId: string,
    runId: string,
    now = Date.now(),
  ): CollaborationRun {
    return this.workflowStore.apply(
      workflowId,
      {
        type: "BROKER_RECONCILIATION_REQUIRED",
        eventId: `${runId}:reconciliation-required`,
        stageId,
        runId,
      },
      now,
    );
  }

  recordPrelaunchOutcome(
    workflowId: string,
    input: unknown,
    now = Date.now(),
  ): CollaborationRun {
    const parsed = PrelaunchOutcomeReceiptSchema.safeParse(input);
    if (!parsed.success) invalidRunnerOutcomeEvidence(`invalid prelaunch receipt: ${parsed.error.message}`);
    const receipt = parsed.data;
    const current = this.workflowStore.get(workflowId);
    const active = current?.activeStage;
    if (!current || !active || current.status !== "running" || receipt.workflowId !== workflowId) {
      invalidRunnerOutcomeEvidence("prelaunch receipt has no matching active workflow stage");
    }
    const dispatchIndex = current.dispatches.findIndex((dispatch) =>
      dispatch.stageId === active.id && isDeepStrictEqual(dispatch.assignment, active.assignment));
    const expectedDispatchId = `${workflowId}:dispatch:${dispatchIndex}`;
    if (dispatchIndex < 0 || receipt.dispatchId !== expectedDispatchId || receipt.stageId !== active.id ||
        receipt.attemptId !== active.assignment.attemptId ||
        receipt.attemptOrdinal !== active.assignment.attemptOrdinal ||
        receipt.agent !== active.assignment.agent || receipt.model !== active.assignment.model ||
        receipt.policyVersion !== active.assignment.policyVersion ||
        receipt.sessionId !== active.assignment.sessionId) {
      invalidRunnerOutcomeEvidence("prelaunch receipt does not match the active dispatch identity");
    }
    const runs = new RunStore(this.databasePath);
    let run: RunRecord | undefined;
    try { run = runs.get(receipt.runId); } finally { runs.close(); }
    const expectedStatus = isFailoverOutcome(receipt.resultKind) ? "completed" : "failed";
    const envelope = asObject(run?.result);
    const providerResult = asObject(envelope?.providerResult);
    const effect = asObject(envelope?.effect);
    if (!run || run.launched || run.attemptCount !== receipt.runAttemptCount ||
        run.idempotencyKey !== receipt.dispatchId || run.status !== expectedStatus ||
        run.payload?.workflowId !== workflowId || run.payload.workflowStageId !== active.id ||
        run.payload.workflowDispatchId !== receipt.dispatchId ||
        !isDeepStrictEqual(run.payload.workflowDispatchIdentity, active.assignment) ||
        (envelope?.domainEffect !== "pending" && envelope?.domainEffect !== "applying" &&
          envelope?.domainEffect !== "applied") ||
        providerResult?.kind !== receipt.resultKind || providerResult.agent !== receipt.agent ||
        effect?.type !== "workflow_dispatch_rejected" || effect.workflowId !== workflowId ||
        effect.stageId !== active.id || effect.runId !== receipt.runId ||
        effect.reason !== receipt.resultKind || !isDeepStrictEqual(effect.prelaunchReceipt, receipt)) {
      invalidRunnerOutcomeEvidence("prelaunch receipt does not match exact durable broker evidence");
    }
    if (isFailoverOutcome(receipt.resultKind)) {
      return this.workflowStore.apply(
        workflowId,
        {
          type: "PROVIDER_OUTCOME",
          eventId: `${receipt.runId}:dispatch-provider-unavailable`,
          agent: active.assignment.agent,
          outcome: { kind: receipt.resultKind },
          now,
        },
        now,
      );
    }
    return this.workflowStore.apply(
      workflowId,
      {
        type: "BROKER_DISPATCH_REJECTED",
        eventId: `${receipt.runId}:dispatch-rejected`,
        stageId: active.id,
        runId: receipt.runId,
        reason: receipt.resultKind,
      },
      now,
    );
  }

  private assertQueueReplay(
    existing: RunRecord,
    expected: {
      stage: string;
      priority: number;
      artifactHash: string;
      approvalScope: string;
      payload: Record<string, unknown>;
      dependsOnRunId?: string;
    },
  ): void {
    if (
      existing.stage !== expected.stage ||
      existing.priority !== expected.priority ||
      existing.artifactHash !== expected.artifactHash ||
      existing.approvalScope !== expected.approvalScope ||
      existing.dependsOnRunId !== expected.dependsOnRunId ||
      !isDeepStrictEqual(existing.payload, sanitizeResult(expected.payload))
    ) {
      throw new Error("dispatch id conflicts with immutable queue payload");
    }
  }

  drainDispatchOutbox(runs: RunStore, now = Date.now()): number {
    let published = 0;
    for (const candidate of this.workflowStore.pendingDispatchCandidates()) {
      if ("error" in candidate) {
        this.workflowStore.quarantineDispatch(candidate, candidate.error, now);
        continue;
      }
      const item = candidate.value;
      let stage: ActiveStage;
      try {
        stage = item.stage;
        if (item.dispatchId !== candidate.dispatchId || item.workflowId !== candidate.workflowId) {
          throw new Error("outbox payload conflicts with its durable row identity");
        }
        const durable = this.workflowStore.get(item.workflowId);
        const index = Number(item.dispatchId.slice(item.dispatchId.lastIndexOf(":") + 1));
        const dispatch = Number.isSafeInteger(index) ? durable?.dispatches[index] : undefined;
        const definition = dispatch ? durable?.stages.find(({ id }) => id === dispatch.stageId) : undefined;
        if (!durable || !dispatch || !definition || !isDeepStrictEqual(item.dispatch, dispatch) ||
            !isDeepStrictEqual(stage, { ...definition, assignment: dispatch.assignment })) {
          throw new Error("outbox payload conflicts with durable workflow snapshot");
        }
        this.admission.assertDispatch(item.workflowId, durable, stage.id, stage.assignment.agent);
      } catch (error) {
        this.workflowStore.quarantineDispatch(
          candidate,
          error instanceof Error ? error.message : String(error),
          now,
        );
        continue;
      }
      const dispatchIndex = Number(
        item.dispatchId.slice(item.dispatchId.lastIndexOf(":") + 1),
      );
      const predecessor =
        dispatchIndex > 0
          ? runs.getByIdempotencyKey(
              `${item.workflowId}:dispatch:${dispatchIndex - 1}`,
            )
          : undefined;
      const payload: Record<string, unknown> = {
        requester: stage.requester,
        preferredAgent: stage.assignment.agent,
        project: stage.project,
        prompt: stage.prompt,
        sourceFingerprint: stage.sourceFingerprint,
        mapLearning: structuredClone(stage.mapLearning),
        approvalScope: stage.approvalScope,
        decision: effortDecision(stage.assignment),
        sessionId: stage.assignment.sessionId,
        workflowDispatchIdentity: structuredClone(stage.assignment),
        workflowDispatchId: item.dispatchId,
        executionSnapshot: structuredClone(stage.executionSnapshot),
        ...(stage.authorizationConsumerKey
          ? { authorizationConsumerKey: stage.authorizationConsumerKey }
          : {}),
        allowFallback: false,
        workflowId: item.workflowId,
        workflowStageId: stage.id,
      };
      const expected = {
        stage: stage.kind,
        priority: stage.kind === "coordination" ? 0 : 10,
        artifactHash: stage.artifactHash,
        approvalScope: stage.approvalScope,
        payload,
        ...(predecessor ? { dependsOnRunId: predecessor.id } : {}),
      };
      try {
        const existing = runs.getByIdempotencyKey(item.dispatchId);
        if (existing) {
          this.assertQueueReplay(existing, expected);
        } else {
          const enqueued = runs.enqueue({
            idempotencyKey: item.dispatchId,
            ...expected,
          });
          this.assertQueueReplay(enqueued, expected);
        }
      } catch (error) {
        if (/database is (?:busy|locked)|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(error))) throw error;
          this.workflowStore.quarantineDispatch(
            candidate,
            error instanceof Error ? error.message : String(error),
            now,
          );
          continue;
      }
      this.workflowStore.markPublished(item.dispatchId, now);
      published += 1;
    }
    return published;
  }

  close(): void {
    this.workflowStore.close();
    this.reviews.close();
    this.approvals.close();
    this.db.close();
  }
}
