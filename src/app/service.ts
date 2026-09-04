import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { openStateDatabaseLease, type StateDatabaseAccess } from "../store/state-database-fence.js";
import { HistoryIndex } from "../history/index.js";
import { buildHistoryContext } from "../history/context.js";
import { HistoryVisibilityPolicy } from "../history/visibility-policy.js";
import type { CollabService, DelegateInput, ReviewInput, SearchInput } from "../mcp/server.js";
import { createCollaborationRun, type StageDefinition } from "../workflow/workflow.js";
import {
  preferredAgentForStage,
  routeStage,
  stageRequiresReadOnly,
  type ReviewProviderHealthSnapshot,
  type ReviewProviderId,
} from "../domain/routing.js";
import { RunStore } from "../store/run-store.js";
import { validateGraphFlow } from "../workflow/flow-contract.js";
import { ApprovalLedger } from "../security/approval-ledger.js";
import { executionAuthorityConsumerKey, snapshotFromBinding } from "../flow/execution-snapshot.js";
import { defaultAllowedProjectRoots, ProjectPolicy } from "../security/project-policy.js";
import { ProviderHealthStore } from "../runtime/provider-health-store.js";
import { RunGateUnitOfWork } from "../runtime/run-gate-unit-of-work.js";
import { captureWorkspaceFingerprint } from "../runtime/workspace-fingerprint.js";
import { ReviewEvidenceCapture } from "../runtime/review-evidence-capture.js";
import { assertReviewV3SchemaSignature } from "../migration/review-v3-schema.js";
import { CollaborationRuntime } from "../runtime/collaboration-runtime.js";
import { REVIEW_BARRIER_POLICY } from "../domain/review.js";
import { redactSensitive } from "../security/redaction.js";
import { auditSharedSkills, sharedSkillReadiness } from "../skills/audit.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
  MapControlPlane,
  type MapLearningEvidenceInput,
  type MapLearningEvidenceReconciliation,
  type MapLearningBytesInput,
} from "../flow/map-admin.js";
import {
  mapAdmissionGates,
  mapAdmissionReviewExpectation,
  mapProfileSha256,
  type MapAdmissionProof,
} from "../flow/map-admission.js";
import { ReviewApplicationService } from "./review-application-service.js";
import { denyLegacyLinearDelegation } from "../runtime/legacy-linear-quarantine.js";

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
const reviewHealth = (snapshot: ReturnType<ProviderHealthStore["snapshot"]>) => ({
  grok: snapshot.grok.health,
  claude: snapshot.claude.health,
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
  readonly stateDatabase: string;
  readonly runs: RunStore; readonly history: HistoryIndex; readonly approvals: ApprovalLedger;
  readonly providers: ProviderHealthStore; readonly reviews: RunGateUnitOfWork;
  readonly runtime: CollaborationRuntime;
  private readonly mapControl: MapControlPlane;
  private readonly projects: ProjectPolicy;
  private readonly sharedSkillsRoot = join(homedir(), ".agents", "skills");
  private readonly agentSkillRoots: Readonly<Record<"grok" | "claude" | "codex", string>>;
  private readonly reviewApplication: ReviewApplicationService;
  private readonly stateLease: StateDatabaseAccess;
  constructor(stateDatabase: string | StateDatabaseAccess, options?: { allowedRoots?: string[]; historyDatabase?: string;
    agentSkillRoots?: Readonly<Record<"grok" | "claude" | "codex", string>>;
    evidenceCapture?: ReviewEvidenceCapture }) {
    const rawOptions = options as Record<string, unknown> | undefined;
    if (rawOptions && ("harnessReady" in rawOptions || "sourceFingerprint" in rawOptions)) {
      throw new Error("legacy raw review evidence options are unsupported; use typed evidence capture");
    }
    this.stateLease = typeof stateDatabase === "string"
      ? openStateDatabaseLease(stateDatabase, "mutating_service")
      : stateDatabase;
    const rollback: Array<() => void> = [() => this.stateLease.close()];
    try {
    this.stateDatabase = this.stateLease.canonicalPath;
    assertReviewV3SchemaSignature(this.stateLease.database);
    this.agentSkillRoots = options?.agentSkillRoots ?? {
      grok: join(homedir(), ".grok", "skills"),
      claude: join(homedir(), ".claude", "skills"),
      codex: join(homedir(), ".codex", "skills"),
    };
    const evidenceCapture = options?.evidenceCapture ?? new ReviewEvidenceCapture({
      captureSource: ({ project }) => {
        const source = captureWorkspaceFingerprint(project);
        return { sourceFingerprint: source.fingerprint, valid: true };
      },
      captureReadiness: ({ agent }) => {
        const readiness = sharedSkillReadiness(auditSharedSkills({
          canonicalRoot: this.sharedSkillsRoot, agentRoots: this.agentSkillRoots,
        }))[agent];
        return readiness
          ? { harnessReady: true, state: "ready", valid: true }
          : { harnessReady: false, state: "provider_unavailable", valid: false };
      },
    });
    this.runs = new RunStore(this.stateLease.borrow());
    rollback.push(() => this.runs.close());
    const historyDatabase = options?.historyDatabase ?? join(dirname(this.stateDatabase), "history.db");
    this.history = new HistoryIndex(historyDatabase, { visibilityPolicy: new HistoryVisibilityPolicy() });
    rollback.push(() => this.history.close());
    if (historyDatabase !== ":memory:") chmodSync(historyDatabase, 0o600);
    this.approvals = new ApprovalLedger(this.stateLease.borrow());
    rollback.push(() => this.approvals.close());
    this.providers = new ProviderHealthStore(this.stateLease.borrow(), { cooldownMs: 60_000 });
    rollback.push(() => this.providers.close());
    this.reviews = new RunGateUnitOfWork(this.stateLease.borrow());
    rollback.push(() => this.reviews.close());
    this.mapControl = new MapControlPlane(this.stateLease.borrow());
    rollback.push(() => this.mapControl.close());
    this.runtime = new CollaborationRuntime(this.stateLease.borrow());
    rollback.push(() => this.runtime.close());
    this.projects = new ProjectPolicy(options?.allowedRoots ?? defaultAllowedProjectRoots());
    this.reviewApplication = new ReviewApplicationService({
      runs: this.runs,
      reviews: this.reviews,
      providers: this.providers,
      projects: this.projects,
      evidenceCapture,
    });
    } catch (error) {
      for (const close of rollback.reverse()) {
        try { close(); } catch { /* preserve the construction error */ }
      }
      throw error;
    }
  }
  async status() {
    const runs = this.runs.list();
    return {
      providers: Object.fromEntries(Object.entries(this.providers.snapshot()).map(([agent, state]) => [agent, state.health])),
      reviewPolicy: {
        required: REVIEW_BARRIER_POLICY.requiredRoles.map(
          (role) => `${REVIEW_BARRIER_POLICY.requiredAgent}:${role}`,
        ),
        optional: REVIEW_BARRIER_POLICY.optionalAgents.flatMap(
          (agent) => REVIEW_BARRIER_POLICY.requiredRoles.map((role) => `${agent}:${role}`),
        ),
        optionalUnavailableBlocks: REVIEW_BARRIER_POLICY.optionalUnavailableBlocks,
        optionalChangesRequestedBlocks: REVIEW_BARRIER_POLICY.optionalChangesRequestedBlocks,
        optionalNeedsReconciliationBlocks: REVIEW_BARRIER_POLICY.optionalNeedsReconciliationBlocks,
      },
      queue: Object.fromEntries(["queued", "claimed", "completed", "failed", "cancelled", "needs_reconciliation"]
        .map((status) => [status, runs.filter((run) => run.status === status).length])),
      protocol: "agent-collab/v2",
      capabilities: { graphFlowValidation: "flow/v1" },
      memorySources: this.history.memorySourceHealth(),
    };
  }
  async validateFlow(input: unknown) {
    const validated = validateGraphFlow(input);
    return {
      schemaVersion: "GraphFlowValidation/v1",
      flowId: validated.graph.flowId,
      nodeCount: validated.graph.nodes.length,
      edgeCount: validated.graph.edges.length,
      valid: true,
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
  private assertAuthorized(project: string, scope: "workspace-read" | "workspace-write" | "external", reference?: string,
    consumerKey?: string): void {
    if (scope === "workspace-read") return;
    if (!reference) throw new Error(`${scope} requires a durable approval reference`);
    const result = this.approvals.validate({ reference, project, scope,
      ...(consumerKey ? { consumerKey } : {}) });
    if (!result.allowed) throw new Error(`approval denied: ${result.reason}`);
  }
  private assertSharedSkills(health: ReviewProviderHealthSnapshot): {
    health: ReviewProviderHealthSnapshot;
    skillReady: Readonly<Record<ReviewProviderId, boolean>>;
  } {
    const audit = auditSharedSkills({
      canonicalRoot: this.sharedSkillsRoot,
      agentRoots: this.agentSkillRoots,
    });
    const skillReady = sharedSkillReadiness(audit);
    if (!skillReady.codex) {
      throw new Error("shared skill manifest is unavailable or divergent");
    }
    return {
      health: {
        ...health,
        grok: skillReady.grok ? health.grok : "unavailable",
        claude: skillReady.claude ? health.claude : "unavailable",
      },
      skillReady,
    };
  }
  closeMapLearning(input: MapLearningBytesInput) {
    return this.mapControl.closeLearning(input);
  }
  recordMapLearningEvidence(input: MapLearningEvidenceInput) {
    return this.mapControl.recordLearningEvidence(input);
  }
  inspectMapLearningEvidenceClaim(id: string) {
    return this.mapControl.inspectLearningEvidenceClaim(id);
  }
  reconcileMapLearningEvidenceClaim(id: string, input: MapLearningEvidenceReconciliation) {
    return this.mapControl.reconcileLearningEvidenceClaim(id, input);
  }
  private ensureMapAdmission(
    input: DelegateInput,
    project: string,
    workflow: ReturnType<typeof createCollaborationRun>,
    _health: ReviewProviderHealthSnapshot,
  ) {
    const target = this.runtime.reviewTarget(workflow, input.idempotencyKey);
    const snapshot = snapshotFromBinding(target.binding);
    const profile = snapshot.mapProfile;
    const source = snapshot.workspace;
    const gates = mapAdmissionGates(input.stage);
    if (gates.length === 0) return { satisfied: true, profile, gates: [] };
    if (input.requester !== "codex") {
      throw new Error("only the local Codex workflow owner may mint MAP review grants");
    }
    const snapshots = gates.map((gate) => {
      const expectation = mapAdmissionReviewExpectation({
        project,
        targetStageId: input.idempotencyKey,
        gate,
        artifact: target.bytes,
        sourceFingerprint: source.fingerprint,
        changedFiles: source.changedFiles.length,
      });
      if (!this.reviews.findExact(expectation)) {
        const admission = this.reviewApplication.captureAdmission(
          "map_admission",
          project,
          expectation.reviewId,
          expectation.sourceFingerprint,
        );
        const created = this.reviews.createWithResult({
          ...expectation,
          health: admission.health,
          admissionEvidence: admission.admissionEvidence,
          createdAt: Date.now(),
        });
        if (created.created) this.reviewApplication.applyAdmissionFailures(admission);
      }
      const { reviewId } = expectation;
      const runs = this.reviewApplication.reviewRuns(reviewId, "codex");
      return { name: gate.name, reviewId, barrier: this.reviews.barrier(reviewId), runIds: runs.map((run) => run.id) };
    });
    return {
      satisfied: snapshots.every(({ barrier }) => barrier.satisfied),
      profile,
      gates: snapshots,
      proof: {
        schemaVersion: "map-admission/v1",
        targetStageId: input.idempotencyKey,
        targetSha256: target.binding.snapshotSha256,
        sourceFingerprint: source.fingerprint,
        mapProfileSha256: mapProfileSha256(profile),
        gates: snapshots.map(({ name, reviewId }, index) => ({
          name,
          stageId: gates[index]!.stageId,
          reviewId,
        })),
      } satisfies MapAdmissionProof,
    };
  }
  async delegate(_input: DelegateInput): Promise<never> {
    return denyLegacyLinearDelegation();
  }
  async requestReview(input: ReviewInput) {
    return this.reviewApplication.requestReview(input);
  }
  async reviewStatus(input: { reviewId: string }) {
    return this.reviewApplication.reviewStatus(input);
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
  close(): void {
    this.history.close(); this.runs.close(); this.approvals.close(); this.providers.close();
    this.reviews.close(); this.mapControl.close(); this.runtime.close(); this.stateLease.close();
  }
}
