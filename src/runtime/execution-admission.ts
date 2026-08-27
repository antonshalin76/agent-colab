import Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { stageRequiresReadOnly, type ActiveAgentId } from "../domain/routing.js";
import { mapAdmissionGates, mapAdmissionReviewExpectation, mapProfileSha256,
  type MapAdmissionProof } from "../flow/map-admission.js";
import { assertCurrentControlMapLearningLaunchBinding, verifyCurrentMapProfile,
  type VerifiedMapProfile } from "../flow/map-admin.js";
import {
  bindExecutionSnapshot, createExecutionSnapshot, executionSnapshotBytes,
  snapshotFromBinding, type ExecutionSnapshotBinding,
} from "../flow/execution-snapshot.js";
import { ApprovalLedger } from "../security/approval-ledger.js";
import { CollaborationRunStore } from "../store/collaboration-run-store.js";
import type { AttemptAssignment, CollaborationRun, StageDefinition, WorkflowEvent } from "../workflow/workflow.js";
import { RunGateUnitOfWork } from "./run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint, type WorkspaceFingerprint } from "./workspace-fingerprint.js";
export class ExecutionAdmission {
  constructor(
    private readonly db: Database.Database,
    private readonly workflows: CollaborationRunStore,
    private readonly reviews: RunGateUnitOfWork,
    private readonly approvals: ApprovalLedger,
    private readonly currentProfile: () => VerifiedMapProfile = verifyCurrentMapProfile,
    private readonly currentWorkspace: (project: string) => WorkspaceFingerprint = captureWorkspaceFingerprint,
  ) {}
  prepareCandidate(workflowId: string, input: CollaborationRun): CollaborationRun {
    const replay = this.workflows.get(workflowId);
    const run = structuredClone(input);
    const profile = this.currentProfile();
    const workspaces = new Map<string, WorkspaceFingerprint>();
    try {
      for (const stage of run.stages) {
        if (!stage.project) throw new Error("workflow stage lacks a project for execution snapshot");
        const workspace = workspaces.get(stage.project) ?? this.currentWorkspace(stage.project);
        workspaces.set(stage.project, workspace);
        stage.executionSnapshot = bindExecutionSnapshot(createExecutionSnapshot({
          workflowId, run, stageId: stage.id, workspace, mapProfile: profile,
        }));
      }
    } catch (error) {
      if (replay) throw new Error("workflow id conflicts with immutable collaboration input");
      throw error;
    }
    this.workflows.assertReplayCompatible(workflowId, run);
    return run;
  }
  snapshotBytes(run: CollaborationRun, stageId: string): Buffer {
    const binding = run.stages.find(({ id }) => id === stageId)?.executionSnapshot;
    if (!binding) throw new Error(`execution snapshot is missing for stage: ${stageId}`);
    return executionSnapshotBytes(snapshotFromBinding(binding));
  }
  private assertStage(workflowId: string, run: CollaborationRun, stage: StageDefinition,
    agent: ActiveAgentId, requireConsumedAuthority = true): void {
    if (agent !== "codex" || !stage.project || !stage.prompt || !stage.executionSnapshot) {
      throw new Error("only Codex may execute a snapshotted workflow stage");
    }
    assertCurrentControlMapLearningLaunchBinding(agent, stage.mapLearning, stage.prompt);
    if (stageRequiresReadOnly(stage.kind) && stage.approvalScope !== "workspace-read") {
      throw new Error(`${stage.kind} is read-only and cannot receive mutation authority`);
    }
    const workspace = this.currentWorkspace(stage.project);
    const profile = this.currentProfile();
    const expected = bindExecutionSnapshot(createExecutionSnapshot({
      workflowId, run, stageId: stage.id, workspace, mapProfile: profile,
    }));
    if (!isDeepStrictEqual(stage.executionSnapshot, expected)) {
      throw new Error(`execution snapshot is stale or conflicts with stage: ${stage.id}`);
    }
    if (requireConsumedAuthority && stage.approvalScope !== "workspace-read" && (!stage.authorizationConsumerKey ||
        !this.approvals.hasConsumption({ consumerKey: stage.authorizationConsumerKey,
          project: stage.project, scope: stage.approvalScope }))) {
      throw new Error(`${stage.approvalScope} stage lacks exact consumed authority`);
    }
    const bytes = executionSnapshotBytes(snapshotFromBinding(expected));
    for (const gate of mapAdmissionGates(stage.kind)) {
      this.reviews.assertExactSemanticPass(mapAdmissionReviewExpectation({
        project: stage.project, targetStageId: stage.id, gate, artifact: bytes,
        sourceFingerprint: workspace.fingerprint, changedFiles: workspace.changedFiles.length,
      }));
    }
  }
  assertDispatch(workflowId: string, run: CollaborationRun, stageId: string, agent: ActiveAgentId): void {
    const stage = run.stages.find(({ id }) => id === stageId);
    if (!stage) throw new Error(`execution stage is missing: ${stageId}`);
    this.assertStage(workflowId, run, stage, agent);
  }
  assertQueued(input: { workflowId: string; stageId: string; dispatchId: string; assignment: AttemptAssignment;
    agent: ActiveAgentId; artifactHash: string; project: string; prompt: string; requester: ActiveAgentId;
    sourceFingerprint: string; approvalScope: StageDefinition["approvalScope"]; authorizationConsumerKey?: string;
    binding: ExecutionSnapshotBinding }): void {
    const run = this.workflows.get(input.workflowId);
    const stage = run?.stages.find(({ id }) => id === input.stageId);
    if (!run || !stage || !stage.executionSnapshot ||
        !isDeepStrictEqual(stage.executionSnapshot, input.binding)) {
      throw new Error("queued execution snapshot conflicts with durable workflow");
    }
    const dispatchIndex = run.dispatches.findIndex((dispatch) => dispatch.stageId === input.stageId &&
      isDeepStrictEqual(dispatch.assignment, input.assignment));
    if (run.status !== "running" || run.activeStage?.id !== input.stageId || dispatchIndex < 0 ||
        input.dispatchId !== `${input.workflowId}:dispatch:${dispatchIndex}` ||
        !isDeepStrictEqual(run.activeStage.assignment, input.assignment)) {
      throw new Error("queued execution assignment conflicts with the active durable dispatch");
    }
    const snapshot = snapshotFromBinding(input.binding);
    if (snapshot.workflowId !== input.workflowId || snapshot.stage.id !== input.stageId ||
        snapshot.stage.artifactHash !== input.artifactHash || snapshot.stage.project !== input.project ||
        snapshot.stage.prompt !== input.prompt || snapshot.stage.requester !== input.requester ||
        snapshot.stage.sourceFingerprint !== input.sourceFingerprint ||
        snapshot.stage.approvalScope !== input.approvalScope ||
        snapshot.stage.authorizationConsumerKey !== (input.authorizationConsumerKey ?? null)) {
      throw new Error("queue payload conflicts with immutable execution snapshot");
    }
    this.assertStage(input.workflowId, run, stage, input.agent);
  }
  startAdmittedWorkflow(input: {
    workflowId: string; run: CollaborationRun; proofs: readonly MapAdmissionProof[];
    approvalReference?: string; event: WorkflowEvent; now: number;
  }): CollaborationRun {
    return this.db.transaction(() => {
      const existing = this.workflows.assertReplayCompatible(input.workflowId, input.run);
      if (existing) return existing;
      const gated = input.run.stages.filter((stage) => mapAdmissionGates(stage.kind).length > 0);
      if (input.proofs.length !== gated.length) throw new Error("MAP admission proof count does not match gated stages");
      const proofs = new Map(input.proofs.map((proof) => [proof.targetStageId, proof]));
      if (proofs.size !== input.proofs.length) throw new Error("MAP proofs contain duplicate stages");
      for (const stage of input.run.stages) {
        this.assertStage(input.workflowId, input.run, stage, "codex", false);
        const binding = stage.executionSnapshot;
        if (!binding) throw new Error(`execution snapshot is missing for stage: ${stage.id}`);
        const proof = proofs.get(stage.id);
        if (mapAdmissionGates(stage.kind).length > 0) {
          const snapshot = snapshotFromBinding(binding);
          const expectedGates = mapAdmissionGates(stage.kind);
          if (!proof || proof.targetSha256 !== binding.snapshotSha256 ||
              proof.sourceFingerprint !== snapshot.workspace.fingerprint ||
              proof.mapProfileSha256 !== mapProfileSha256(snapshot.mapProfile) ||
              proof.gates.length !== expectedGates.length || proof.gates.some((actual, index) => {
                const expected = expectedGates[index]!;
                return actual.name !== expected.name || actual.stageId !== expected.stageId ||
                  actual.reviewId !== mapAdmissionReviewExpectation({ project: stage.project!,
                    targetStageId: stage.id, gate: expected, artifact: executionSnapshotBytes(snapshot),
                    sourceFingerprint: snapshot.workspace.fingerprint,
                    changedFiles: snapshot.workspace.changedFiles.length }).reviewId;
              })) throw new Error(`MAP proof does not match execution snapshot: ${stage.id}`);
        } else if (proof) throw new Error(`ungated stage carries a MAP proof: ${stage.id}`);
        if (stage.approvalScope !== "workspace-read") {
          if (!input.approvalReference || !stage.project || !stage.authorizationConsumerKey) {
            throw new Error(`${stage.approvalScope} stage lacks authority reference`);
          }
          const consumed = this.approvals.validateAndConsume({ reference: input.approvalReference,
            project: stage.project, scope: stage.approvalScope,
            consumerKey: stage.authorizationConsumerKey, now: input.now });
          if (!consumed.allowed) throw new Error(`approval denied: ${consumed.reason}`);
        }
      }
      return this.workflows.createStartedIfAbsent(input.workflowId, input.run, input.event, input.now);
    }).immediate();
  }
}
