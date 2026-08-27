import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionAdmission } from "../src/runtime/execution-admission.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { ApprovalLedger } from "../src/security/approval-ledger.js";
import { CollaborationRunStore } from "../src/store/collaboration-run-store.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { createCollaborationRun, type CollaborationRun, type StageDefinition } from "../src/workflow/workflow.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
  verifyCurrentMapProfile,
} from "../src/flow/map-admin.js";
import { executionAuthorityConsumerKey, snapshotFromBinding } from "../src/flow/execution-snapshot.js";
import { mapAdmissionGates, mapAdmissionReviewExpectation, mapProfileSha256 } from "../src/flow/map-admission.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-admission-"));
  roots.push(root);
  const project = join(root, "project"); mkdirSync(project);
  const database = join(root, "state.db"); initializeCurrentExecutionSchema(database);
  const db = new Database(database);
  const workflows = new CollaborationRunStore(db);
  const reviews = new RunGateUnitOfWork(db);
  const approvals = new ApprovalLedger(db);
  const workspace = captureWorkspaceFingerprint(project);
  const mapLearning = createCurrentMapLearningLaunchBinding("codex");
  const stage: StageDefinition = {
    id: "target", kind: "planning", role: "stage-owner", artifactRef: `artifact:${"a".repeat(64)}`,
    artifactHash: "a".repeat(64), artifactBytes: 128, changedFiles: workspace.changedFiles.length,
    approvalScope: "workspace-write", idempotencyKey: "target", project,
    prompt: `${formatMapLearningLaunchBindingContext(mapLearning)}\n\nchange the exact target`,
    requester: "codex", sourceFingerprint: workspace.fingerprint, mapLearning,
  };
  stage.authorizationConsumerKey = executionAuthorityConsumerKey("workflow", stage);
  const run = createCollaborationRun({ taskId: "task", origin: "codex",
    health: { grok: "healthy", codex: "healthy" }, stages: [stage] });
  approvals.issue({ reference: "approval", project, scope: "workspace-write", expiresAt: Date.now() + 60_000 });
  return { root, project, db, workflows, reviews, approvals, run };
};

const close = (input: ReturnType<typeof fixture>) => {
  input.approvals.close(); input.reviews.close(); input.workflows.close(); input.db.close();
};

const acceptingReviews = { assertExactSemanticPass: () => undefined } as unknown as RunGateUnitOfWork;
const proofs = (run: CollaborationRun) => {
  const stage = run.stages.find(({ id }) => id === "target")!;
  const binding = stage.executionSnapshot!;
  const snapshot = snapshotFromBinding(binding);
  return [{ schemaVersion: "map-admission/v1" as const, targetStageId: stage.id,
    targetSha256: binding.snapshotSha256, sourceFingerprint: snapshot.workspace.fingerprint,
    mapProfileSha256: mapProfileSha256(snapshot.mapProfile),
    gates: mapAdmissionGates(stage.kind).map((gate) => ({ name: gate.name, stageId: gate.stageId,
      reviewId: mapAdmissionReviewExpectation({ project: stage.project!, targetStageId: stage.id, gate,
        artifact: Buffer.from(binding.snapshotBase64, "base64"),
        sourceFingerprint: snapshot.workspace.fingerprint,
        changedFiles: snapshot.workspace.changedFiles.length }).reviewId })) }];
};

describe("execution admission UoW", () => {
  it("rolls authority consumption back when workflow and outbox start fails, then retries once", () => {
    const state = fixture();
    try {
      const admission = new ExecutionAdmission(state.db, state.workflows, acceptingReviews, state.approvals);
      const candidate = admission.prepareCandidate("workflow", state.run);
      expect(() => admission.startAdmittedWorkflow({ workflowId: "workflow", run: candidate, proofs: proofs(candidate),
        approvalReference: "approval", event: { type: "BEGIN_STAGE", stageId: "missing", now: 1,
          eventId: "invalid-start" }, now: 1 })).toThrow();
      const key = candidate.stages.find(({ id }) => id === "target")!.authorizationConsumerKey!;
      expect(state.approvals.hasConsumption({ consumerKey: key, project: state.project,
        scope: "workspace-write" })).toBe(false);
      expect(state.approvals.validate({ reference: "approval", project: state.project,
        scope: "workspace-write", now: 2 })).toEqual({ allowed: true, remainingUses: 1 });
      expect(state.workflows.get("workflow")).toBeNull();
      expect(state.workflows.pendingDispatches()).toEqual([]);

      const started = admission.startAdmittedWorkflow({ workflowId: "workflow", run: candidate, proofs: proofs(candidate),
        approvalReference: "approval", event: { type: "BEGIN_STAGE", stageId: candidate.stages[0]!.id,
          now: 3, eventId: "valid-start" }, now: 3 });
      expect(started.status).toBe("running");
      expect(state.approvals.hasConsumption({ consumerKey: key, project: state.project,
        scope: "workspace-write" })).toBe(true);
      expect(state.workflows.pendingDispatches()).toHaveLength(1);
    } finally { close(state); }
  });

  it("blocks source and MAP profile drift before consuming authority or creating durable state", () => {
    for (const drift of ["source", "profile"] as const) {
      const state = fixture();
      try {
        const admittedProfile = verifyCurrentMapProfile();
        let profile = admittedProfile;
        const admission = new ExecutionAdmission(state.db, state.workflows, acceptingReviews, state.approvals,
          () => profile);
        const candidate = admission.prepareCandidate("workflow", state.run);
        if (drift === "source") writeFileSync(join(state.project, "drift.txt"), "changed\n");
        else profile = { ...admittedProfile, profileLockSha256: "f".repeat(64) };
        expect(() => admission.startAdmittedWorkflow({ workflowId: "workflow", run: candidate, proofs: proofs(candidate),
          approvalReference: "approval", event: { type: "BEGIN_STAGE", stageId: candidate.stages[0]!.id,
            now: 1, eventId: `drift-${drift}` }, now: 1 })).toThrow(/snapshot.*stale|workspace evidence/i);
        expect(state.approvals.validate({ reference: "approval", project: state.project,
          scope: "workspace-write", now: 2 })).toEqual({ allowed: true, remainingUses: 1 });
        expect(state.workflows.get("workflow")).toBeNull();
      } finally { close(state); }
    }
  });

  it("rejects a conflicting replay before any new review or authority side effect", () => {
    const state = fixture();
    try {
      const admission = new ExecutionAdmission(state.db, state.workflows, acceptingReviews, state.approvals);
      const candidate = admission.prepareCandidate("workflow", state.run);
      admission.startAdmittedWorkflow({ workflowId: "workflow", run: candidate, proofs: proofs(candidate),
        approvalReference: "approval", event: { type: "BEGIN_STAGE", stageId: candidate.stages[0]!.id,
          now: 1, eventId: "start" }, now: 1 });
      const conflicting: CollaborationRun = structuredClone(state.run);
      conflicting.stages.find(({ id }) => id === "target")!.prompt += "\nforged";
      expect(() => admission.prepareCandidate("workflow", conflicting))
        .toThrow(/workflow id conflicts with immutable/i);
      expect(state.workflows.pendingDispatches()).toHaveLength(1);
    } finally { close(state); }
  });
});
