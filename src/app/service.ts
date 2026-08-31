import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
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
import { ReviewEvidenceCapture, type ReviewEvidenceCaptureEntryPoint } from "../runtime/review-evidence-capture.js";
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
  readonly runs: RunStore; readonly history: HistoryIndex; readonly approvals: ApprovalLedger;
  readonly providers: ProviderHealthStore; readonly reviews: RunGateUnitOfWork;
  readonly runtime: CollaborationRuntime;
  private readonly mapControl: MapControlPlane;
  private readonly projects: ProjectPolicy;
  private readonly sharedSkillsRoot = join(homedir(), ".agents", "skills");
  private readonly agentSkillRoots: Readonly<Record<"grok" | "claude" | "codex", string>>;
  private readonly evidenceCapture: ReviewEvidenceCapture;
  constructor(readonly stateDatabase: string, options?: { allowedRoots?: string[]; historyDatabase?: string;
    agentSkillRoots?: Readonly<Record<"grok" | "claude" | "codex", string>>;
    evidenceCapture?: ReviewEvidenceCapture }) {
    const rawOptions = options as Record<string, unknown> | undefined;
    if (rawOptions && ("harnessReady" in rawOptions || "sourceFingerprint" in rawOptions)) {
      throw new Error("legacy raw review evidence options are unsupported; use typed evidence capture");
    }
    const schema = new Database(stateDatabase, { readonly: true });
    try { assertReviewV3SchemaSignature(schema); } finally { schema.close(); }
    this.agentSkillRoots = options?.agentSkillRoots ?? {
      grok: join(homedir(), ".grok", "skills"),
      claude: join(homedir(), ".claude", "skills"),
      codex: join(homedir(), ".codex", "skills"),
    };
    this.evidenceCapture = options?.evidenceCapture ?? new ReviewEvidenceCapture({
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
    this.runs = new RunStore(stateDatabase);
    const historyDatabase = options?.historyDatabase ?? join(dirname(stateDatabase), "history.db");
    this.history = new HistoryIndex(historyDatabase, { visibilityPolicy: new HistoryVisibilityPolicy() });
    if (historyDatabase !== ":memory:") chmodSync(historyDatabase, 0o600);
    this.approvals = new ApprovalLedger(stateDatabase);
    this.providers = new ProviderHealthStore(stateDatabase, { cooldownMs: 60_000 });
    this.reviews = new RunGateUnitOfWork(stateDatabase);
    this.mapControl = new MapControlPlane(stateDatabase);
    this.runtime = new CollaborationRuntime(stateDatabase);
    this.projects = new ProjectPolicy(options?.allowedRoots ?? defaultAllowedProjectRoots());
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
  private captureAdmission(
    entryPoint: Extract<ReviewEvidenceCaptureEntryPoint, "request_review" | "map_admission">,
    project: string,
    reviewId: string,
  ): { health: ReviewProviderHealthSnapshot; sourceFingerprint: string;
    admissionReceipts: Array<{ agent: ReviewProviderId; role: "auditor" | "critic";
      activationNonce: string; sourceReceiptId: string; readinessReceiptId: string }> } {
    const outcomes = new Map<string, ReturnType<ReviewEvidenceCapture["capture"]>>();
    const unavailableForThisAdmission = new Set<ReviewProviderId>();
    for (const agent of ["grok", "claude", "codex"] as const) {
      for (const role of ["auditor", "critic"] as const) {
        const outcome = this.evidenceCapture.capture({ entryPoint, phase: "admission",
          project, agent, role });
        outcomes.set(`${agent}:${role}`, outcome);
      }
      const auditor = outcomes.get(`${agent}:auditor`)!;
      const critic = outcomes.get(`${agent}:critic`)!;
      const pairIsEquivalent = auditor.kind === critic.kind &&
          auditor.kind !== "infrastructure_failure" &&
          critic.kind !== "infrastructure_failure" &&
          JSON.stringify(auditor.source) === JSON.stringify(critic.source) &&
          JSON.stringify(auditor.readiness) === JSON.stringify(critic.readiness);
      const pairIsReady = pairIsEquivalent && auditor.kind === "ready" && critic.kind === "ready";
      if (!pairIsReady) {
        if (agent === "codex") {
          throw new Error("mandatory Codex auditor/critic pair is unavailable or divergent");
        }
        unavailableForThisAdmission.add(agent);
        const unavailable = [auditor, critic].find(
          (outcome) => outcome.kind === "provider_unavailable",
        );
        if (unavailable?.kind === "provider_unavailable") {
          this.providers.applyCaptureOutcome(unavailable);
        }
        continue;
      }
    }
    const persistedHealth = reviewHealth(this.providers.snapshot());
    const health: ReviewProviderHealthSnapshot = {
      ...persistedHealth,
      ...Object.fromEntries([...unavailableForThisAdmission].map((agent) => [agent, "unavailable"])),
    } as ReviewProviderHealthSnapshot;
    const codexSource = outcomes.get("codex:auditor")!;
    if (codexSource.kind !== "ready") throw new Error("mandatory Codex evidence capture failed");
    const admissionReceipts: Array<{ agent: ReviewProviderId; role: "auditor" | "critic";
      activationNonce: string; sourceReceiptId: string; readinessReceiptId: string }> = [];
    for (const agent of ["grok", "claude", "codex"] as const) {
      if (health[agent] !== "healthy" || unavailableForThisAdmission.has(agent)) continue;
      for (const role of ["auditor", "critic"] as const) {
        const outcome = outcomes.get(`${agent}:${role}`)!;
        if (outcome.kind !== "ready") {
          throw new Error(`healthy review provider lacks ready evidence: ${agent}/${role}`);
        }
        const sourceScope = `review/${reviewId}/${agent}/${role}/source`;
        const readinessScope = `review/${reviewId}/${agent}/${role}/readiness`;
        const cursor = this.reviews.receiptPairCursor({ sourceScope, readinessScope });
        const activationNonce = randomUUID();
        const sourceReceiptId = randomUUID();
        const readinessReceiptId = randomUUID();
        const captured = this.reviews.captureReviewReceiptPair({
          pairId: randomUUID(), phase: "admission", activationNonce,
          scopeRevision: cursor.scopeRevision, recoveryGeneration: null,
          expectedTuple: { laneRevision: 0, latestOrdinal: null, latestEvidenceHash: null },
          predecessorReceiptIds: cursor.predecessorReceiptIds,
          receipts: {
            source: { receiptId: sourceReceiptId, scope: sourceScope, observation: outcome.source },
            readiness: { receiptId: readinessReceiptId, scope: readinessScope,
              observation: outcome.readiness },
          },
          createdAt: outcome.observedAt,
        });
        if (captured.lifecycle !== "pending") {
          throw new Error(`admission receipt pair lost current head: ${agent}/${role}`);
        }
        admissionReceipts.push({ agent, role, activationNonce, sourceReceiptId, readinessReceiptId });
      }
    }
    return { health, sourceFingerprint: codexSource.source.sourceFingerprint, admissionReceipts };
  }
  private reviewRuns(reviewId: string, requester: "grok" | "codex") {
    return this.reviews.enqueueDescriptors(reviewId)
      .map((lane) => {
        if (lane.requester !== requester) {
          throw new Error("review requester changed before durable enqueue");
        }
        const run = this.runs.getByIdempotencyKey(lane.idempotencyKey);
        if (!run) throw new Error("atomic review run is missing");
        return run;
      });
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
      const admission = this.captureAdmission("map_admission", project, expectation.reviewId);
      this.reviews.create({
        ...expectation,
        health: admission.health,
        sourceFingerprint: admission.sourceFingerprint,
        admissionReceipts: admission.admissionReceipts,
        createdAt: Date.now(),
      });
      const { reviewId } = expectation;
      const runs = this.reviewRuns(reviewId, "codex");
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
  async delegate(input: DelegateInput) {
    const providerSnapshot = this.providers.snapshot();
    const sharedSkills = this.assertSharedSkills(reviewHealth(providerSnapshot));
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
    if (redactSensitive(input.prompt) !== input.prompt) {
      throw new Error("delegated prompt contains credential material and cannot be persisted exactly");
    }
    const policyOwner = preferredAgentForStage(input.stage);
    if (input.preferredAgent && input.preferredAgent !== policyOwner) {
      throw new Error(`routing policy requires ${policyOwner} for ${input.stage}`);
    }
    const persistedInputKey = scopedIdempotencyKey(project, input.idempotencyKey);
    const existingWorkflow = this.runtime.workflows.get(persistedInputKey);
    const workspace = captureWorkspaceFingerprint(project);
    const mapLearning = createCurrentMapLearningLaunchBinding("codex");
    const workflowPrompt = `${input.stage === "planning" ? "MAP control plane: use the installed map-plan contract before proposing implementation.\n\n" : ""}${formatMapLearningLaunchBindingContext(mapLearning)}\n\n${input.prompt}\n\nImmutable artifact (${input.artifactHash}):\n${input.artifactContent}`;
    const taskId = input.taskId ?? input.idempotencyKey.split(":")[0] ?? input.idempotencyKey;
    const workflowTaskId = scopedIdempotencyKey(project, taskId);
    const health = routingHealth(providerSnapshot);
    const targetStage: StageDefinition = { id: input.idempotencyKey, kind: input.stage,
      role: input.stage === "coordination" ? "coordinator" as const : "stage-owner" as const,
      artifactRef: `artifact:${input.artifactHash}`, artifactHash: input.artifactHash,
      artifactBytes: artifact.length, changedFiles: workspace.changedFiles.length,
      approvalScope: input.approvalScope, idempotencyKey: persistedInputKey,
      project, prompt: workflowPrompt, requester: input.requester,
      sourceFingerprint: workspace.fingerprint, mapLearning };
    if (input.approvalScope !== "workspace-read") {
      targetStage.authorizationConsumerKey = executionAuthorityConsumerKey(persistedInputKey, targetStage);
    }
    const workflow = createCollaborationRun({
      taskId: workflowTaskId, origin: input.requester, health,
      stages: [targetStage],
    });
    const candidate = this.runtime.prepareCandidate(persistedInputKey, workflow);
    if (!existingWorkflow) {
      this.assertAuthorized(project, input.approvalScope, input.approvalReference,
        targetStage.authorizationConsumerKey);
    }
    const mapAdmission = this.ensureMapAdmission(
      input,
      project,
      candidate,
      sharedSkills.health,
    );
    if (!mapAdmission.satisfied) {
      return {
        runId: persistedInputKey,
        assignedAgent: "codex",
        status: "blocked_map_admission",
        mapAdmission,
      };
    }
    const state = this.runtime.createAndStart(
      persistedInputKey,
      candidate,
      mapAdmission.proof === undefined ? [] : [mapAdmission.proof],
      Date.now(),
      input.approvalReference,
    );
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
    if (input.requester !== "codex") {
      throw new Error("only Codex may mint a review grant at the local stdio boundary");
    }
    const project = this.projects.resolveReviewWorkspace(input.workspaceRoot);
    if (input.approvalScope !== "workspace-read") throw new Error("review lanes are immutable read-only operations");
    if (redactSensitive(input.artifactContent) !== input.artifactContent) {
      throw new Error("review artifact contains credential material and cannot preserve its exact hash safely");
    }
    const artifact = Buffer.from(input.artifactContent, "utf8");
    const actualHash = createHash("sha256").update(artifact).digest("hex");
    if (actualHash !== input.artifactHash) throw new Error("review artifact hash mismatch");
    const reviewId = scopedIdempotencyKey(project, input.idempotencyKey);
    const safePrompt = redactSensitive(input.prompt);
    const source = captureWorkspaceFingerprint(project);
    const admission = this.captureAdmission("request_review", project, reviewId);
    const review = this.reviews.create({ reviewId, stageId: input.stageId ?? "independent-review", artifact,
      health: admission.health,
      approvalScope: "workspace-read", idempotencyKey: reviewId,
      prompts: { auditor: `AUDITOR independent lane. ${safePrompt}`, critic: `CRITIC independent lane. ${safePrompt}` },
      createdAt: Date.now(), project, requester: input.requester,
      sourceFingerprint: admission.sourceFingerprint, changedFiles: source.changedFiles.length,
      admissionReceipts: admission.admissionReceipts });
    const runs = this.reviewRuns(reviewId, input.requester);
    return { reviewId, laneCount: 6, activeLaneCount: runs.length, runState: review.runState, runIds: runs.map((lane) => lane.id) };
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
  close(): void { this.history.close(); this.runs.close(); this.approvals.close(); this.providers.close(); this.reviews.close(); this.mapControl.close(); this.runtime.close(); }
}
