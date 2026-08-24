import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ProviderOutcome } from "../domain/outcomes.js";
import type {
  ActiveAgentId,
  EffortDecision,
  ProviderHealthSnapshot,
} from "../domain/routing.js";
import { sanitizeResult } from "../security/redaction.js";
import { CollaborationRunStore } from "../store/collaboration-run-store.js";
import type { RunRecord, RunStore } from "../store/run-store.js";
import type {
  AttemptAssignment,
  CheckpointEvidence,
  CollaborationRun,
  ObservedWorktree,
} from "../workflow/workflow.js";
import { WorktreeLeaseStore } from "../worktree/lease-store.js";

export type DispatchDisposition =
  | "execute"
  | "completed"
  | "superseded"
  | "terminal";

const effortDecision = (assignment: AttemptAssignment): EffortDecision => ({
  agent: assignment.agent,
  model: assignment.model,
  effort: assignment.effort,
  policyVersion: assignment.policyVersion,
  reasons: structuredClone(assignment.reasons),
  degraded: assignment.degraded,
});

export class CollaborationRuntime {
  readonly workflows: CollaborationRunStore;
  private readonly leases: WorktreeLeaseStore;

  constructor(path: string) {
    this.workflows = new CollaborationRunStore(path);
    this.leases = new WorktreeLeaseStore(path);
  }

  createAndStart(
    workflowId: string,
    run: CollaborationRun,
    now = Date.now(),
  ): CollaborationRun {
    return this.workflows.createStartedIfAbsent(
      workflowId,
      run,
      {
        type: "BEGIN_STAGE",
        stageId: run.stages[0]!.id,
        now,
        eventId: `${workflowId}:begin:0`,
      },
      now,
    );
  }

  dispatchDisposition(
    workflowId: string,
    stageId: string,
    queuedAssignment: AttemptAssignment,
  ): DispatchDisposition {
    const state = this.workflows.get(workflowId);
    if (!state) return "terminal";
    if (state.completedStageIds.includes(stageId)) return "completed";
    if (
      state.status === "terminal_outcome" ||
      state.status === "blocked_handoff_conflict" ||
      state.status === "blocked_retry_exhausted"
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

  completeStage(
    workflowId: string,
    stageId: string,
    assignment: AttemptAssignment,
    result: unknown,
    now = Date.now(),
  ): CollaborationRun {
    const current = this.workflows.get(workflowId);
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
    return this.workflows.applyMany(
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

  recordTerminalOutcome(
    workflowId: string,
    assignment: AttemptAssignment,
    outcome: ProviderOutcome,
    now = Date.now(),
  ): CollaborationRun {
    const current = this.workflows.get(workflowId);
    if (!current?.activeStage || !isDeepStrictEqual(current.activeStage.assignment, assignment)) {
      throw new Error(`Workflow has no active stage: ${workflowId}`);
    }
    const active = current.activeStage;
    return this.workflows.apply(
      workflowId,
      {
        type: "PROVIDER_OUTCOME",
        eventId: `${workflowId}:terminal:${active.id}:${active.assignment.attemptId}:${outcome.kind}`,
        agent: active.assignment.agent,
        outcome,
        now,
        handoffEvidence: {
          checkpoint: {
            artifactHash: active.artifactHash,
            headSha: "not-applicable",
            diffHash: "not-applicable",
            changedFiles: [],
            testEvidence: [],
            sourceSessionId: `workflow:${workflowId}`,
            approvals: [],
            nextAction: {
              kind: "continue_stage",
              stageId: active.id,
              instruction: "terminal outcome; do not continue",
            },
          },
          worktreeLease: {
            path: active.project ?? "",
            leaseId: "not-applicable",
            holder: active.assignment.agent,
            fencingToken: 0,
          },
        },
        observedWorktree: {
          artifactHash: active.artifactHash,
          headSha: "not-applicable",
          diffHash: "not-applicable",
          leaseId: "not-applicable",
          fencingToken: 0,
        },
      },
      now,
    );
  }

  recordProviderOutcome(
    workflowId: string,
    input: {
      from: ActiveAgentId;
      outcome: ProviderOutcome;
      health: ProviderHealthSnapshot;
      checkpoint: CheckpointEvidence;
      lease: {
        worktreePath: string;
        leaseId: string;
        holder: ActiveAgentId;
        fencingToken: number;
      };
      observed: ObservedWorktree;
      assignment: AttemptAssignment;
      outcomeEventId: string;
    },
    now = Date.now(),
  ): CollaborationRun {
    const current = this.workflows.get(workflowId);
    if (
      !current?.activeStage ||
      current.activeStage.assignment.agent !== input.from ||
      !isDeepStrictEqual(current.activeStage.assignment, input.assignment)
    ) {
      throw new Error(
        "failover source does not match the active workflow assignment",
      );
    }
    return this.workflows.applyMany(
      workflowId,
      [
        {
          type: "PROVIDER_HEALTH_CHANGED",
          agent: "grok",
          health: input.health.grok,
        },
        {
          type: "PROVIDER_HEALTH_CHANGED",
          agent: "codex",
          health: input.health.codex,
        },
        {
          type: "PROVIDER_OUTCOME",
          eventId: `${workflowId}:failover:${current.activeStage.id}:${current.activeStage.assignment.attemptId}:${input.from}:${input.outcome.kind}:${input.outcomeEventId}`,
          agent: input.from,
          outcome: input.outcome,
          now,
          handoffEvidence: {
            checkpoint: input.checkpoint,
            worktreeLease: {
              path: input.lease.worktreePath,
              leaseId: input.lease.leaseId,
              holder: input.lease.holder,
              fencingToken: input.lease.fencingToken,
            },
          },
          observedWorktree: input.observed,
        },
      ],
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
    for (const item of this.workflows.pendingDispatches()) {
      const stage = item.stage;
      if (!stage.project || !stage.prompt || !stage.requester) {
        throw new Error("workflow dispatch lacks execution context");
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
      let handoffLease;
      if (item.handoff) {
        const expected = item.handoff.releasedLease;
        const transferred = this.leases.transferImmediate({
          worktreePath: expected.path,
          expectedLeaseId: expected.leaseId,
          expectedFencingToken: expected.fencingToken,
          from: item.handoff.from,
          to: item.handoff.to,
          now,
          ttlMs: 31 * 60_000,
          evidence: item.handoff.evidence,
          allowAlreadyTransferred: true,
        });
        if (transferred.status !== "transferred") {
          this.workflows.apply(
            item.workflowId,
            {
              type: "HANDOFF_TRANSFER_CONFLICT",
              eventId: `${item.dispatchId}:lease-transfer-fenced`,
              stageId: stage.id,
              expectedFencingToken: expected.fencingToken,
              currentFencingToken: transferred.currentFencingToken,
            },
            now,
          );
          this.workflows.markPublished(item.dispatchId, now);
          continue;
        }
        handoffLease = transferred.lease;
      }
      const handoffPrompt = item.handoff
        ? `VERIFIED HANDOFF PACKET (do not widen authority):\n${JSON.stringify(item.handoff.evidence)}\n\n${stage.prompt}`
        : stage.prompt;
      const payload: Record<string, unknown> = {
        requester: stage.requester,
        preferredAgent: stage.assignment.agent,
        project: stage.project,
        prompt: handoffPrompt,
        approvalScope: stage.approvalScope,
        decision: effortDecision(stage.assignment),
        sessionId: stage.assignment.sessionId,
        workflowDispatchIdentity: structuredClone(stage.assignment),
        ...(stage.approvalReference
          ? { approvalReference: stage.approvalReference }
          : {}),
        allowFallback: !item.handoff,
        ...(handoffLease ? { handoffLease } : {}),
        ...(item.handoff &&
        typeof (
          item.handoff.evidence.checkpoint as CheckpointEvidence & {
            workspaceFingerprint?: string;
          }
        ).workspaceFingerprint === "string"
          ? {
              expectedCheckpoint: {
                workspaceFingerprint: (
                  item.handoff.evidence.checkpoint as CheckpointEvidence & {
                    workspaceFingerprint: string;
                  }
                ).workspaceFingerprint,
                artifactHash: item.handoff.evidence.checkpoint.artifactHash,
              },
            }
          : {}),
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
      this.workflows.markPublished(item.dispatchId, now);
      published += 1;
    }
    return published;
  }

  close(): void {
    this.workflows.close();
    this.leases.close();
  }
}
