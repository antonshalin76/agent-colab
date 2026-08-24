import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { HistoryIndex } from "../history/index.js";
import { buildHistoryContext } from "../history/context.js";
import { HistoryVisibilityPolicy } from "../history/visibility-policy.js";
import type { CollabService, DelegateInput, ReviewInput, SearchInput } from "../mcp/server.js";
import { createCollaborationRun } from "../workflow/workflow.js";
import { preferredAgentForStage, routeStage, stageRequiresReadOnly } from "../domain/routing.js";
import { RunStore } from "../store/run-store.js";
import { ApprovalLedger } from "../security/approval-ledger.js";
import { defaultAllowedProjectRoots, ProjectPolicy } from "../security/project-policy.js";
import { ProviderHealthStore } from "../runtime/provider-health-store.js";
import { ReviewBarrierStore } from "../runtime/review-barrier-store.js";
import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import { CollaborationRuntime } from "../runtime/collaboration-runtime.js";
import { redactSensitive } from "../security/redaction.js";
import { auditSharedSkills } from "../skills/audit.js";

const walk = (root: string, suffix: string): string[] => {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith(suffix)) found.push(path);
    }
  };
  visit(root); return found;
};
const readPrefix = (path: string, limit = 65_536): string => {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(limit);
    const bytes = readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } finally { closeSync(fd); }
};
export const codexSessionProject = (path: string): string | null => {
  for (const line of readPrefix(path).split(/\r?\n/)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown } };
      if (record.type === "session_meta") return typeof record.payload?.cwd === "string" ? record.payload.cwd : null;
    } catch { /* malformed records are handled by the indexer */ }
  }
  return null;
};
const scopedIdempotencyKey = (project: string, key: string): string =>
  `${createHash("sha256").update(project).digest("hex").slice(0, 24)}:${key}`;

const routingHealth = (snapshot: ReturnType<ProviderHealthStore["snapshot"]>) => ({
  grok: snapshot.grok.health,
  codex: snapshot.codex.health,
}) as const;

export const grokSessionProject = (path: string): string | null => {
  const encodedProject = basename(dirname(dirname(path)));
  try {
    return decodeURIComponent(encodedProject);
  } catch {
    return null;
  }
};

export const projectMemorySection = (
  content: string,
  project: string,
): { startLine: number; endLine: number } | null => {
  const lines = content.split(/\r?\n/);
  const canonical = resolve(project);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(?:Project:\s*)?(.+?)\s*$/.exec(lines[index] ?? "");
    if (!heading || !heading[2]!.startsWith("/")) continue;
    let candidate: string;
    try { candidate = resolve(heading[2]!); } catch { continue; }
    if (candidate !== canonical) continue;
    const level = heading[1]!.length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[cursor] ?? "");
      if (next && next[1]!.length <= level) { end = cursor; break; }
    }
    return end <= index + 1 ? null : { startLine: index + 2, endLine: end };
  }
  return null;
};

const grokRepositoryIdentity = (project: string): string => {
  const remote = spawnSync("git", ["-C", project, "remote", "get-url", "origin"], {
    encoding: "utf8", timeout: 5_000, shell: false,
  });
  if (remote.status !== 0 || !remote.stdout.trim()) return resolve(project);
  const raw = remote.stdout.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
  const scp = /^[^@]+@[^:]+:(.+)$/.exec(raw);
  if (scp) return scp[1]!;
  try {
    const pathname = new URL(raw).pathname.replace(/^\//, "");
    return pathname || resolve(project);
  } catch {
    return raw;
  }
};

export const grokWorkspaceMemoryDirectory = (project: string, userRoot = homedir()): string => {
  const identity = grokRepositoryIdentity(resolve(project));
  const repoName = identity.split("/").filter(Boolean).at(-1) ?? basename(project);
  const slug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  return join(userRoot, ".grok", "memory", `${slug}-${hash}`);
};

export class LocalCollabService implements CollabService {
  readonly runs: RunStore; readonly history: HistoryIndex; readonly approvals: ApprovalLedger;
  readonly providers: ProviderHealthStore; readonly reviews: ReviewBarrierStore;
  readonly runtime: CollaborationRuntime;
  private readonly projects: ProjectPolicy;
  private readonly sharedSkillsRoot = join(homedir(), ".agents", "skills");
  private readonly agentSkillRoots: Readonly<Record<"grok" | "codex", string>>;
  constructor(readonly stateDatabase: string, options?: { allowedRoots?: string[]; historyDatabase?: string;
    agentSkillRoots?: Readonly<Record<"grok" | "codex", string>> }) {
    this.runs = new RunStore(stateDatabase);
    const historyDatabase = options?.historyDatabase ?? join(dirname(stateDatabase), "history.db");
    this.history = new HistoryIndex(historyDatabase, { visibilityPolicy: new HistoryVisibilityPolicy() });
    if (historyDatabase !== ":memory:") chmodSync(historyDatabase, 0o600);
    this.approvals = new ApprovalLedger(stateDatabase);
    this.providers = new ProviderHealthStore(stateDatabase, { cooldownMs: 60_000 });
    this.reviews = new ReviewBarrierStore(stateDatabase);
    this.runtime = new CollaborationRuntime(stateDatabase);
    this.projects = new ProjectPolicy(options?.allowedRoots ?? defaultAllowedProjectRoots());
    this.agentSkillRoots = options?.agentSkillRoots ?? {
      grok: join(homedir(), ".grok", "skills"), codex: join(homedir(), ".codex", "skills"),
    };
  }
  async status() {
    const runs = this.runs.list();
    return {
      providers: Object.fromEntries(Object.entries(this.providers.snapshot()).map(([agent, state]) => [agent, state.health])),
      queue: Object.fromEntries(["queued", "claimed", "completed", "failed", "cancelled", "needs_reconciliation"]
        .map((status) => [status, runs.filter((run) => run.status === status).length])),
      protocol: "agent-collab/v2",
      memorySources: this.history.memorySourceHealth(),
    };
  }
  async search(input: SearchInput) {
    if (!input.project) throw new Error("project is required for history isolation");
    const project = this.projects.resolve(input.project);
    const candidates = this.history.search({ requester: input.requester, project,
      ...(input.query ? { query: input.query } : {}),
      kinds: input.kind === "memory" ? ["memory"] : ["message", "tool_summary"], limit: 50 });
    const rows: typeof candidates = []; let bytes = 0;
    for (const row of candidates) {
      let bounded = row; let encoded = Buffer.byteLength(JSON.stringify(bounded));
      if (encoded > 4_096) {
        bounded = { ...row, content: `${row.content.slice(0, 3_000)}\n[retrieval truncated; contentHash identifies full indexed record]` };
        encoded = Buffer.byteLength(JSON.stringify(bounded));
      }
      if (bytes + encoded > 12_000) break;
      rows.push(bounded); bytes += encoded;
    }
    return buildHistoryContext({ rows });
  }
  private authorize(project: string, scope: "workspace-read" | "workspace-write" | "external", reference?: string,
    consumerKey?: string): void {
    if (scope === "workspace-read") return;
    if (!reference) throw new Error(`${scope} requires a durable approval reference`);
    const result = this.approvals.validateAndConsume({ reference, project, scope,
      ...(consumerKey ? { consumerKey } : {}) });
    if (!result.allowed) throw new Error(`approval denied: ${result.reason}`);
  }
  private assertSharedSkills(): void {
    const audit = auditSharedSkills({
      canonicalRoot: this.sharedSkillsRoot,
      agentRoots: this.agentSkillRoots,
    });
    if (!audit.consistent) throw new Error("shared skill manifest is unavailable or divergent");
  }
  async delegate(input: DelegateInput) {
    this.assertSharedSkills();
    if (stageRequiresReadOnly(input.stage) && input.approvalScope !== "workspace-read") {
      throw new Error(`${input.stage} is a read-only stage and cannot receive mutation authority`);
    }
    const project = this.projects.resolve(input.project);
    const artifact = Buffer.from(input.artifactContent, "utf8");
    if (createHash("sha256").update(artifact).digest("hex") !== input.artifactHash) {
      throw new Error("delegated artifact hash mismatch");
    }
    if (redactSensitive(input.artifactContent) !== input.artifactContent) {
      throw new Error("delegated artifact contains credential material and cannot be persisted exactly");
    }
    const policyOwner = preferredAgentForStage(input.stage);
    if (input.preferredAgent && input.preferredAgent !== policyOwner) throw new Error(`routing policy requires ${policyOwner} for ${input.stage}`);
    const persistedInputKey = scopedIdempotencyKey(project, input.idempotencyKey);
    const existingWorkflow = this.runtime.workflows.get(persistedInputKey);
    const taskId = input.taskId ?? input.idempotencyKey.split(":")[0] ?? input.idempotencyKey;
    const workflowTaskId = scopedIdempotencyKey(project, taskId);
    const providerSnapshot = this.providers.snapshot();
    const health = routingHealth(providerSnapshot);
    const workspace = captureWorkspaceFingerprint(project);
    const workflow = createCollaborationRun({
      taskId: workflowTaskId, origin: input.requester, health,
      stages: [{ id: input.idempotencyKey, kind: input.stage, role: input.stage === "coordination" ? "coordinator" : "stage-owner",
        artifactRef: `artifact:${input.artifactHash}`, artifactHash: input.artifactHash,
        artifactBytes: artifact.length, changedFiles: workspace.changedFiles.length,
        approvalScope: input.approvalScope, idempotencyKey: persistedInputKey,
        project, prompt: `${input.prompt}\n\nImmutable artifact (${input.artifactHash}):\n${input.artifactContent}`,
        requester: input.requester,
        ...(input.approvalReference ? { approvalReference: input.approvalReference } : {}) }],
    });
    if (!existingWorkflow) this.authorize(project, input.approvalScope, input.approvalReference, persistedInputKey);
    const state = this.runtime.createAndStart(persistedInputKey, workflow);
    this.runtime.drainDispatchOutbox(this.runs);
    const requestedStage = state.stages.find((stage) => stage.id === input.idempotencyKey)!;
    let assignedAgent = state.activeStage?.id === requestedStage.id
      ? state.activeStage.assignment.agent : preferredAgentForStage(requestedStage.kind);
    try { assignedAgent = routeStage({ stage: requestedStage.kind, origin: input.requester, health: state.health,
      role: requestedStage.role, artifactRef: requestedStage.artifactRef, artifactHash: requestedStage.artifactHash,
      approvalScope: requestedStage.approvalScope, idempotencyKey: requestedStage.idempotencyKey,
      trustedInputs: { artifactBytes: requestedStage.artifactBytes, changedFiles: requestedStage.changedFiles,
        attemptOrdinal: 0, approvalScope: requestedStage.approvalScope } }).assignedAgent; } catch { /* blocked */ }
    return { runId: persistedInputKey, assignedAgent, status: state.status };
  }
  async requestReview(input: ReviewInput) {
    this.assertSharedSkills();
    const project = this.projects.resolve(input.project);
    if (input.approvalScope !== "workspace-read") throw new Error("review lanes are immutable read-only operations");
    if (redactSensitive(input.artifactContent) !== input.artifactContent) {
      throw new Error("review artifact contains credential material and cannot preserve its exact hash safely");
    }
    const artifact = Buffer.from(input.artifactContent, "utf8");
    const actualHash = createHash("sha256").update(artifact).digest("hex");
    if (actualHash !== input.artifactHash) throw new Error("review artifact hash mismatch");
    const snapshot = this.providers.snapshot();
    const health = routingHealth(snapshot);
    const reviewId = scopedIdempotencyKey(project, input.idempotencyKey);
    const safePrompt = redactSensitive(input.prompt);
    const source = captureWorkspaceFingerprint(project);
    const review = this.reviews.create({ reviewId, stageId: input.stageId ?? "independent-review", artifact, health,
      approvalScope: "workspace-read", idempotencyKey: reviewId,
      prompts: { auditor: `AUDITOR independent lane. ${safePrompt}`, critic: `CRITIC independent lane. ${safePrompt}` },
      createdAt: Date.now(), project, requester: input.requester,
      sourceFingerprint: source.fingerprint, changedFiles: source.changedFiles.length });
    const runs = this.reviews.enqueueDescriptors(reviewId).map((lane) => this.runs.enqueueExact({
      idempotencyKey: lane.idempotencyKey, stage: `review:${lane.role}`, priority: 5,
      artifactHash: lane.artifactHash, approvalScope: "workspace-read",
      payload: { requester: input.requester, preferredAgent: lane.agent, project,
        prompt: `${lane.prompt}\n\nImmutable artifact (${lane.artifactHash}):\n${lane.artifact.toString("utf8")}`,
        approvalScope: "workspace-read", allowFallback: false, reviewRole: lane.role,
        decision: { agent: lane.agent, model: lane.model, effort: lane.effort,
          policyVersion: lane.policyVersion, reasons: lane.reasons },
        reviewDispatchIdentity: { agent: lane.agent, model: lane.model, effort: lane.effort,
          policyVersion: lane.policyVersion, reasons: lane.reasons, sessionId: lane.sessionId,
          attemptId: lane.attemptId, attemptOrdinal: lane.attemptOrdinal, degraded: lane.degraded },
        reviewId, sessionId: lane.sessionId, artifactHash: lane.artifactHash,
        reviewAttemptId: lane.attemptId, reviewAttemptOrdinal: lane.attemptOrdinal },
    }));
    return { reviewId, laneCount: 4, activeLaneCount: runs.length, runState: review.runState, runIds: runs.map((lane) => lane.id) };
  }
  async runStatus(input: { runId: string }) {
    const run = this.runs.get(input.runId); if (run) return run;
    const review = this.reviews.get(input.runId); if (review) return { review, barrier: this.reviews.barrier(input.runId) };
    return this.runtime.workflows.get(input.runId);
  }
  async indexNow(input?: { project?: string | undefined }) {
    if (!input?.project) throw new Error("project is required for history isolation");
    const project = this.projects.resolve(input.project); const userRoot = homedir();
    const claudeProjectsRoot = join(userRoot, ".claude", "projects");
    const claudeRoot = (existsSync(claudeProjectsRoot) ? readdirSync(claudeProjectsRoot, { withFileTypes: true }) : []).filter((entry) => entry.isDirectory()).map((entry) => join(claudeProjectsRoot, entry.name))
      .find((candidate) => { try { const index = JSON.parse(readFileSync(join(candidate, "sessions-index.json"), "utf8")) as { originalPath?: string }; return index.originalPath ? resolve(index.originalPath) === project : false; } catch { return false; } });
    const claudeThreads = claudeRoot ? walk(claudeRoot, ".jsonl") : [];
    const grokThreads = walk(join(userRoot, ".grok", "sessions"), "chat_history.jsonl")
      .filter((path) => { const cwd = grokSessionProject(path); return cwd !== null && resolve(cwd) === project; });
    const codexThreads = walk(join(userRoot, ".codex", "sessions"), ".jsonl")
      .filter((path) => { const cwd = codexSessionProject(path); return cwd !== null && resolve(cwd) === project; });
    let indexed = 0; const warnings: string[] = [];
    for (const path of claudeThreads) { try { await this.history.indexClaudeFile(path, project); indexed += 1; } catch (error) { warnings.push(`${basename(path)}: ${String(error)}`); } }
    for (const path of grokThreads) { try { await this.history.indexGrokFile(path, project); indexed += 1; } catch (error) { warnings.push(`${basename(dirname(path))}: ${String(error)}`); } }
    for (const path of codexThreads) { try { await this.history.indexCodexFile(path, project); indexed += 1; } catch (error) { warnings.push(`${basename(path)}: ${String(error)}`); } }
    const claudeMemory = claudeRoot ? walk(join(claudeRoot, "memory"), ".md") : [];
    for (const path of claudeMemory) { await this.history.indexMemoryFile({ agent: "claude", path, project }); indexed += 1; }
    const nativeMemoryPaths: { grok: string[]; codex: string[] } = { grok: [], codex: [] };
    const memorySources: Record<"grok" | "codex", "projected" | "unavailable" | "no_project_section"> = {
      grok: "unavailable", codex: "unavailable",
    };
    for (const [agent, path] of [["codex", join(userRoot, ".codex", "memories", "MEMORY.md")]] as const) {
      if (!existsSync(path)) continue;
      const section = projectMemorySection(readFileSync(path, "utf8"), project);
      if (!section) { memorySources[agent] = "no_project_section"; continue; }
      await this.history.indexProjectMemorySection({ agent, path, project, section });
      nativeMemoryPaths[agent].push(path); memorySources[agent] = "projected"; indexed += 1;
    }
    const grokWorkspaceMemory = grokWorkspaceMemoryDirectory(project, userRoot);
    const grokMemoryFiles = [join(grokWorkspaceMemory, "MEMORY.md"),
      ...walk(join(grokWorkspaceMemory, "sessions"), ".md")].filter(existsSync);
    if (grokMemoryFiles.length > 0) {
      for (const path of grokMemoryFiles) {
        await this.history.indexMemoryFile({ agent: "grok", path, project }); indexed += 1;
      }
      nativeMemoryPaths.grok.push(...grokMemoryFiles); memorySources.grok = "projected";
    }
    const memoryUpdatedAt = Date.now();
    this.history.recordMemorySourceHealth({ project, namespace: "codex_native",
      status: memorySources.codex, sourcePath: nativeMemoryPaths.codex[0] ?? null, updatedAt: memoryUpdatedAt });
    this.history.recordMemorySourceHealth({ project, namespace: "grok_native",
      status: memorySources.grok, sourcePath: nativeMemoryPaths.grok[0] ?? null, updatedAt: memoryUpdatedAt });
    this.history.reconcileSources({ agent: "claude", project, presentPaths: [...claudeThreads, ...claudeMemory] });
    this.history.reconcileSources({ agent: "grok", project, presentPaths: [...grokThreads, ...nativeMemoryPaths.grok] });
    this.history.reconcileSources({ agent: "codex", project, presentPaths: [...codexThreads, ...nativeMemoryPaths.codex] });
    return { indexed, warnings, memorySources };
  }
  close(): void { this.history.close(); this.runs.close(); this.approvals.close(); this.providers.close(); this.reviews.close(); this.runtime.close(); }
}
