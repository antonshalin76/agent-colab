import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExecutionSnapshot,
  bindExecutionSnapshot,
  executionAuthorityConsumerKey,
  executionSnapshotBytes,
  executionSnapshotSha256,
  parseExecutionSnapshot,
  snapshotFromBinding,
} from "../src/flow/execution-snapshot.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
  verifyCurrentMapProfile,
} from "../src/flow/map-admin.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { createCollaborationRun, type StageDefinition } from "../src/workflow/workflow.js";

const stage = (project: string, approvalScope: StageDefinition["approvalScope"] = "workspace-read") => {
  const workspace = captureWorkspaceFingerprint(project);
  const mapLearning = createCurrentMapLearningLaunchBinding("codex");
  const prompt = `${formatMapLearningLaunchBindingContext(mapLearning)}\n\nimplement the exact target`;
  const base: StageDefinition = {
    id: "target",
    kind: "tdd_coding",
    role: "stage-owner",
    artifactRef: `artifact:${"a".repeat(64)}`,
    artifactHash: "a".repeat(64),
    artifactBytes: 128,
    changedFiles: workspace.changedFiles.length,
    approvalScope,
    idempotencyKey: "target",
    project,
    prompt,
    requester: "codex",
    sourceFingerprint: workspace.fingerprint,
    mapLearning,
  };
  if (approvalScope !== "workspace-read") {
    base.authorizationConsumerKey = executionAuthorityConsumerKey("workflow", base);
  }
  return { base, workspace };
};

describe("immutable execution snapshot", () => {
  it("round-trips only canonical strict bytes", () => {
    const project = mkdtempSync(join(tmpdir(), "agent-collab-snapshot-"));
    try {
      const { base, workspace } = stage(project);
      const run = createCollaborationRun({ taskId: "task", origin: "codex", health: {
        grok: "healthy", codex: "healthy",
      }, stages: [base] });
      const snapshot = createExecutionSnapshot({
        workflowId: "workflow",
        run,
        stageId: "target",
        workspace,
        mapProfile: verifyCurrentMapProfile(),
      });
      const bytes = executionSnapshotBytes(snapshot);
      expect(parseExecutionSnapshot(bytes)).toEqual(snapshot);
      expect(snapshotFromBinding(bindExecutionSnapshot(snapshot))).toEqual(snapshot);
      expect(executionSnapshotSha256(snapshot)).toMatch(/^[a-f0-9]{64}$/);
      expect(() => parseExecutionSnapshot(Buffer.from(`${bytes.toString("utf8").trim()} `)))
        .toThrow(/canonical/i);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it("binds workspace, stage, MAP profile and MAP learning to one identity", () => {
    const project = mkdtempSync(join(tmpdir(), "agent-collab-snapshot-fields-"));
    try {
      const { base, workspace } = stage(project);
      const run = createCollaborationRun({ taskId: "task", origin: "codex", health: {
        grok: "healthy", codex: "healthy",
      }, stages: [base] });
      const profile = verifyCurrentMapProfile();
      const initial = createExecutionSnapshot({ workflowId: "workflow", run, stageId: "target", workspace,
        mapProfile: profile });
      const hashes = [
        createExecutionSnapshot({ workflowId: "workflow-2", run, stageId: "target", workspace, mapProfile: profile }),
        { ...initial, workspace: { ...initial.workspace, branchRef: "refs/heads/other" } },
        { ...initial, stage: { ...initial.stage, prompt: `${initial.stage.prompt}\nchanged` } },
        { ...initial, stage: { ...initial.stage, artifactHash: "b".repeat(64) } },
        { ...initial, stage: { ...initial.stage, mapLearning: {
          ...initial.stage.mapLearning, digest: "c".repeat(64),
        } } },
        { ...initial, mapProfile: { ...initial.mapProfile, profileLockSha256: "d".repeat(64) } },
      ].map((candidate) => executionSnapshotSha256(candidate));
      expect(new Set([executionSnapshotSha256(initial), ...hashes]).size).toBe(hashes.length + 1);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it("binds mutation authority to the exact target and forbids it on read-only work", () => {
    const project = mkdtempSync(join(tmpdir(), "agent-collab-snapshot-authority-"));
    try {
      const mutable = stage(project, "workspace-write").base;
      expect(executionAuthorityConsumerKey("workflow", { ...mutable, prompt: `${mutable.prompt}\nother` }))
        .not.toBe(mutable.authorizationConsumerKey);
      const readOnly = stage(project).base;
      readOnly.authorizationConsumerKey = "authority:forged";
      const workspace = captureWorkspaceFingerprint(project);
      const run = createCollaborationRun({ taskId: "task", origin: "codex", health: {
        grok: "healthy", codex: "healthy",
      }, stages: [readOnly] });
      expect(() => createExecutionSnapshot({ workflowId: "workflow", run, stageId: "target", workspace,
        mapProfile: verifyCurrentMapProfile() })).toThrow(/read-only.*authority/i);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});
