import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { STAGES, stageRequiresReadOnly } from "../domain/routing.js";
import type { VerifiedMapProfile } from "./map-admin.js";
import type { WorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import type { CollaborationRun, StageDefinition } from "../workflow/workflow.js";
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const HashRecord = z.record(z.string().min(1), Sha256);
const Tool = z.object({
  kind: z.string().min(1), version: z.string().min(1), executablePath: z.string().startsWith("/"),
  executableSha256: Sha256,
}).strict();
const Workspace = z.object({
  headSha: z.string().min(1), branchRef: z.string().min(1), upstreamRef: z.string().min(1),
  upstreamSha: z.string().min(1), baseSha: z.string().min(1), diffHash: Sha256,
  changedFiles: z.array(z.string().min(1)), fingerprint: Sha256,
}).strict();
const MapLearning = z.object({
  schemaVersion: z.literal("map-learning-launch-binding/v1"),
  consumer: z.enum(["codex", "grok"]), projectionBase64: z.string().min(1), digest: Sha256,
}).strict();
const MapProfile = z.object({
  version: z.string().min(1), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  sourceArchiveSha256: Sha256, provider: z.literal("codex"), profile: z.literal("full"),
  minimality: z.literal("lite"), updatesAuto: z.literal(false),
  upstreamSkillInventory: z.array(z.string().min(1)), managedFileSha256: HashRecord,
  outsideScopeSha256: HashRecord, mapManifestSha256: Sha256, mapConfigSha256: Sha256,
  profileLockSha256: Sha256, updateTool: Tool.extend({ kind: z.literal("uv") }).strict(),
  sandboxTool: Tool.extend({ kind: z.literal("bubblewrap") }).strict(),
  runtimeTool: Tool.extend({ kind: z.literal("mapify-cli"), toolRoot: z.string().startsWith("/"),
    toolTreeSha256: Sha256, pythonRealPath: z.string().startsWith("/"), pythonSha256: Sha256 }).strict(),
}).strict();
const SnapshotStage = z.object({
  id: z.string().min(1), kind: z.enum(STAGES), role: z.enum(["stage-owner", "coordinator"]),
  artifactRef: z.string().min(1), artifactHash: Sha256, artifactBytes: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(), approvalScope: z.enum(["workspace-read", "workspace-write", "external"]),
  idempotencyKey: z.string().min(1), systemGenerated: z.boolean(), project: z.string().startsWith("/"),
  prompt: z.string().min(1), requester: z.enum(["grok", "codex"]), sourceFingerprint: Sha256,
  authorizationConsumerKey: z.string().min(1).nullable(), mapLearning: MapLearning,
}).strict();

export const ExecutionSnapshotSchema = z.object({
  schemaVersion: z.literal("execution-snapshot/v1"), workflowId: z.string().min(1),
  taskId: z.string().min(1), origin: z.enum(["grok", "codex"]), policyVersion: z.literal("routing-v4"),
  workspace: Workspace, mapProfile: MapProfile, stage: SnapshotStage,
}).strict();
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;
export const ExecutionSnapshotBindingSchema = z.object({
  schemaVersion: z.literal("execution-snapshot-binding/v1"), snapshotSha256: Sha256,
  snapshotBase64: z.string().min(1),
}).strict();
export type ExecutionSnapshotBinding = z.infer<typeof ExecutionSnapshotBindingSchema>;
const sortedRecord = (value: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const workspaceIdentity = (value: WorkspaceFingerprint): string => sha256(JSON.stringify({
  headSha: value.headSha, branchRef: value.branchRef, upstreamRef: value.upstreamRef,
  upstreamSha: value.upstreamSha, baseSha: value.baseSha, diffHash: value.diffHash,
  changedFiles: value.changedFiles,
}));
const stageProjection = (stage: StageDefinition) => ({
  id: stage.id, kind: stage.kind, role: stage.role, artifactRef: stage.artifactRef,
  artifactHash: stage.artifactHash, artifactBytes: stage.artifactBytes, changedFiles: stage.changedFiles,
  approvalScope: stage.approvalScope, idempotencyKey: stage.idempotencyKey,
  systemGenerated: stage.systemGenerated ?? false, project: stage.project, prompt: stage.prompt,
  requester: stage.requester, sourceFingerprint: stage.sourceFingerprint,
  authorizationConsumerKey: stage.authorizationConsumerKey ?? null,
  mapLearning: structuredClone(stage.mapLearning),
});
export function executionAuthorityConsumerKey(workflowId: string, stage: StageDefinition): string {
  if (stage.approvalScope === "workspace-read") throw new Error("read-only work cannot have an authority target");
  if (!stage.project || !stage.prompt || !stage.requester || !stage.sourceFingerprint) {
    throw new Error("authority target lacks exact execution context");
  }
  return `authority:${sha256(JSON.stringify({
    schemaVersion: "delegated-authority-target/v3", project: stage.project, requester: stage.requester,
    stage: stage.kind, prompt: stage.prompt, artifactHash: stage.artifactHash,
    approvalScope: stage.approvalScope, workflowId, stageId: stage.id,
    sourceFingerprint: stage.sourceFingerprint, mapLearning: stage.mapLearning,
  }))}`;
}
export function createExecutionSnapshot(input: {
  workflowId: string; run: CollaborationRun; stageId: string;
  workspace: WorkspaceFingerprint; mapProfile: VerifiedMapProfile;
}): ExecutionSnapshot {
  const stage = input.run.stages.find(({ id }) => id === input.stageId);
  if (!stage || !stage.project || !stage.prompt || !stage.requester || !stage.sourceFingerprint) {
    throw new Error("execution snapshot stage lacks exact execution context");
  }
  if (!stage.mapLearning || stage.mapLearning.consumer !== "codex") {
    throw new Error("exact MAP learning is missing from the workflow stage");
  }
  if (workspaceIdentity(input.workspace) !== input.workspace.fingerprint ||
      stage.sourceFingerprint !== input.workspace.fingerprint || stage.changedFiles !== input.workspace.changedFiles.length) {
    throw new Error("execution snapshot workspace evidence is inconsistent");
  }
  if (stageRequiresReadOnly(stage.kind) && stage.approvalScope !== "workspace-read") {
    throw new Error(`${stage.kind} is read-only and cannot receive mutation authority`);
  }
  if (stage.approvalScope === "workspace-read" && stage.authorizationConsumerKey !== undefined) {
    throw new Error("read-only execution snapshot cannot carry authority");
  }
  if (stage.approvalScope !== "workspace-read" &&
      stage.authorizationConsumerKey !== executionAuthorityConsumerKey(input.workflowId, stage)) {
    throw new Error("execution snapshot authority target mismatch");
  }
  return ExecutionSnapshotSchema.parse({
    schemaVersion: "execution-snapshot/v1", workflowId: input.workflowId, taskId: input.run.taskId,
    origin: input.run.origin, policyVersion: input.run.policyVersion, workspace: structuredClone(input.workspace),
    mapProfile: { ...structuredClone(input.mapProfile),
      upstreamSkillInventory: [...input.mapProfile.upstreamSkillInventory].sort(),
      managedFileSha256: sortedRecord(input.mapProfile.managedFileSha256),
      outsideScopeSha256: sortedRecord(input.mapProfile.outsideScopeSha256) },
    stage: stageProjection(stage),
  });
}
export const executionSnapshotBytes = (snapshot: ExecutionSnapshot): Buffer =>
  Buffer.from(`${JSON.stringify(ExecutionSnapshotSchema.parse(snapshot))}\n`, "utf8");
export const executionSnapshotSha256 = (snapshot: ExecutionSnapshot): string => sha256(executionSnapshotBytes(snapshot));
export function parseExecutionSnapshot(bytes: Uint8Array): ExecutionSnapshot {
  if (bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) throw new Error("execution snapshot size is invalid");
  const snapshot = ExecutionSnapshotSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (!isDeepStrictEqual(executionSnapshotBytes(snapshot), Buffer.from(bytes))) {
    throw new Error("execution snapshot bytes are not canonical");
  }
  return snapshot;
}
export function bindExecutionSnapshot(snapshot: ExecutionSnapshot): ExecutionSnapshotBinding {
  const bytes = executionSnapshotBytes(snapshot);
  return { schemaVersion: "execution-snapshot-binding/v1", snapshotSha256: sha256(bytes),
    snapshotBase64: bytes.toString("base64") };
}
export function snapshotFromBinding(input: unknown): ExecutionSnapshot {
  const binding = ExecutionSnapshotBindingSchema.parse(input);
  const bytes = Buffer.from(binding.snapshotBase64, "base64");
  if (bytes.toString("base64") !== binding.snapshotBase64 || sha256(bytes) !== binding.snapshotSha256) {
    throw new Error("execution snapshot binding bytes or hash are invalid");
  }
  return parseExecutionSnapshot(bytes);
}
