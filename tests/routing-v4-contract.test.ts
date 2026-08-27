import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReviewPlan } from "../src/domain/review.js";
import {
  ROUTING_POLICY_VERSION,
  STAGES,
  STAGE_POLICY,
  providerSupportsApprovalScope,
  selectStageAssignment,
} from "../src/domain/routing.js";
import { CollaborationRuntime } from "../src/runtime/collaboration-runtime.js";
import { RunGateUnitOfWork } from "../src/runtime/run-gate-unit-of-work.js";
import { CollaborationRunStore } from "../src/store/collaboration-run-store.js";
import { RunStore } from "../src/store/run-store.js";
import type { RunRecord } from "../src/store/run-store.js";
import {
  createCollaborationRun,
  restoreCollaborationRun,
  transitionCollaborationRun,
  type ActiveStage,
  type CollaborationRun,
  type StageDefinition,
} from "../src/workflow/workflow.js";
import { WorktreeLeaseStore } from "../src/worktree/lease-store.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
} from "../src/flow/map-admin.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

const roots: string[] = [];

const makeRoot = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `agent-collab-${label}-`));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const artifactHash = "a".repeat(64);
const codexLearning = createCurrentMapLearningLaunchBinding("codex");
const learningContext = formatMapLearningLaunchBindingContext(codexLearning);
const failoverOutcomes = new Set([
  "quota", "rate_limit", "overload", "network_timeout", "model_unavailable", "cli_missing", "auth",
]);

const deliveryStage = (project: string): StageDefinition => {
  const workspace = captureWorkspaceFingerprint(project);
  return {
  id: "planning",
  kind: "code_review",
  role: "stage-owner",
  artifactRef: `artifact:${artifactHash}`,
  artifactHash,
  artifactBytes: 1_024,
  changedFiles: workspace.changedFiles.length,
  approvalScope: "workspace-read",
  idempotencyKey: "task:planning",
  project,
  prompt: `${learningContext}\n\nplan`,
  requester: "codex",
  sourceFingerprint: workspace.fingerprint,
  mapLearning: codexLearning,
  };
};

const makeRun = (root: string): CollaborationRun => {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  return createCollaborationRun({
    taskId: "task-v4",
    origin: "grok",
    health: { grok: "healthy", codex: "healthy" },
    stages: [deliveryStage(project)],
  });
};

const runnerReceipt = (
  workflowId: string,
  active: ActiveStage,
  resultKind: string,
  run: RunRecord,
  overrides: Record<string, unknown> = {},
) => ({
  schemaVersion: "runner-outcome/v1",
  runId: run.id,
  runAttemptCount: run.attemptCount,
  dispatchId: run.idempotencyKey,
  workflowId,
  stageId: active.id,
  attemptId: active.assignment.attemptId,
  attemptOrdinal: active.assignment.attemptOrdinal,
  agent: active.assignment.agent,
  model: active.assignment.model,
  policyVersion: active.assignment.policyVersion,
  sessionId: active.assignment.sessionId,
  resultKind,
  ...overrides,
});

const persistRunnerOutcome = (
  runs: RunStore,
  workflowId: string,
  active: ActiveStage,
  resultKind: string,
  now: number,
): { claimed: RunRecord; receipt: ReturnType<typeof runnerReceipt> } => {
  const claimed = runs.claimNext({
    workerId: "broker-test-worker",
    leaseMs: 30_000,
    now: Date.now() + 1_000,
  });
  if (!claimed?.leaseToken) throw new Error("expected claimed runner row");
  const receipt = runnerReceipt(workflowId, active, resultKind, claimed);
  runs.markLaunchIntent(claimed.id, claimed.leaseToken, { agent: active.assignment.agent });
  runs.markLaunched(claimed.id, claimed.leaseToken, {
    phase: "started",
    pid: 12345,
    agent: active.assignment.agent,
    model: active.assignment.model,
    effort: active.assignment.effort,
    policyVersion: active.assignment.policyVersion,
    sessionId: active.assignment.sessionId,
  });
  runs.commitDomainEffect({
    id: claimed.id,
    token: claimed.leaseToken,
    providerResult: { kind: resultKind, agent: active.assignment.agent },
    effect: {
      type: "workflow",
      workflowId,
      stageId: active.id,
      assignment: active.assignment,
      agent: active.assignment.agent,
      resultKind,
      terminalAt: now,
      runnerReceipt: receipt,
    },
    status: resultKind === "success" || failoverOutcomes.has(resultKind) ? "completed" : "failed",
  });
  return { claimed, receipt };
};

const frozenV3Assignment = {
  agent: "grok",
  model: "grok-4.6",
  effort: "medium",
  policyVersion: "routing-v3",
  reasons: ["stage_baseline:planning:medium"],
  degraded: false,
  attemptId: "planning:attempt:0:grok:routing-v3",
  attemptOrdinal: 0,
  sessionId: "11111111-1111-4111-8111-111111111111",
} as const;

const frozenV3CoordinationAssignment = {
  agent: "codex",
  model: "gpt-5.6-sol",
  effort: "medium",
  policyVersion: "routing-v3",
  reasons: ["stage_baseline:coordination:medium"],
  degraded: false,
  attemptId: "coordination:legacy-task-v3:attempt:0:codex:routing-v3",
  attemptOrdinal: 0,
  sessionId: "00000000-0000-4000-8000-000000000000",
} as const;

const frozenV3Stage = (project: string) => ({
  id: "planning",
  kind: "planning",
  role: "stage-owner",
  artifactRef: `artifact:${artifactHash}`,
  artifactHash,
  artifactBytes: 1_024,
  changedFiles: 2,
  approvalScope: "workspace-read",
  idempotencyKey: "legacy:planning",
  project,
  prompt: "legacy plan",
  requester: "grok",
});

const frozenV3CoordinationStage = (project: string) => ({
  id: "coordination:legacy-task-v3",
  kind: "coordination",
  role: "coordinator",
  artifactRef: `artifact:${artifactHash}`,
  artifactHash,
  artifactBytes: 1_024,
  changedFiles: 2,
  approvalScope: "workspace-read",
  idempotencyKey: `legacy-task-v3:coordination:${artifactHash}`,
  systemGenerated: true,
  project,
  prompt: "Coordinate the delegated planning stage before execution. legacy plan",
  requester: "grok",
});

const frozenV3Run = (project: string) => ({
  taskId: "legacy-task-v3",
  origin: "grok",
  policyVersion: "routing-v3",
  health: { grok: "healthy", codex: "healthy" },
  stages: [frozenV3CoordinationStage(project), frozenV3Stage(project)],
  status: "running",
  activeStage: { ...frozenV3Stage(project), assignment: frozenV3Assignment },
  pendingStageId: null,
  handoffs: [],
  dispatches: [
    {
      stageId: "coordination:legacy-task-v3",
      assignment: frozenV3CoordinationAssignment,
      approvalScope: "workspace-read",
      idempotencyKey: `legacy-task-v3:coordination:${artifactHash}`,
    },
    {
      stageId: "planning",
      assignment: frozenV3Assignment,
      approvalScope: "workspace-read",
      idempotencyKey: "legacy:planning",
    },
  ],
  failedAttempts: [],
  completedStageIds: ["coordination:legacy-task-v3"],
  processedEventIds: ["legacy:begin:coordination", "legacy:complete:coordination", "legacy:begin:planning"],
  retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 },
  recovery: null,
  now: 10,
});

const frozenV3Outbox = (workflowId: string, project: string) => ({
  dispatchId: `${workflowId}:dispatch:1`,
  workflowId,
  dispatch: frozenV3Run(project).dispatches[1],
  stage: { ...frozenV3Stage(project), assignment: frozenV3Assignment },
});

const seedFrozenV3Workflow = (database: string, project: string): void => {
  initializeCurrentExecutionSchema(database);
  const schema = new CollaborationRunStore(database);
  schema.close();
  const db = new Database(database);
  db.prepare(`INSERT INTO collaboration_runs(workflow_id,state_json,version,updated_at)
    VALUES (?,?,1,10)`).run("legacy", JSON.stringify(frozenV3Run(project)));
  db.prepare(`INSERT INTO collaboration_dispatch_outbox
    (dispatch_id,workflow_id,payload_json,published_at)
    VALUES (?,?,?,10)`).run(
      "legacy:dispatch:0",
      "legacy",
      JSON.stringify({
        dispatchId: "legacy:dispatch:0",
        workflowId: "legacy",
        dispatch: frozenV3Run(project).dispatches[0],
        stage: { ...frozenV3CoordinationStage(project), assignment: frozenV3CoordinationAssignment },
      }),
    );
  db.prepare(`INSERT INTO collaboration_dispatch_outbox
    (dispatch_id,workflow_id,payload_json,published_at)
    VALUES (?,?,?,NULL)`).run("legacy:dispatch:1", "legacy",
      JSON.stringify(frozenV3Outbox("legacy", project)));
  db.close();
};

const seedFrozenV3Review = (database: string): void => {
  const frozenArtifactHash = createHash("sha256").update(Buffer.from([1])).digest("hex");
  const db = new Database(database);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE runtime_review_barriers (
      review_id TEXT PRIMARY KEY,
      stage_id TEXT NOT NULL,
      artifact BLOB NOT NULL,
      artifact_hash TEXT NOT NULL,
      approval_scope TEXT NOT NULL CHECK (approval_scope = 'workspace-read'),
      idempotency_key TEXT NOT NULL,
      run_state TEXT NOT NULL CHECK (run_state IN ('FULL_CROSS_PROVIDER', 'DEGRADED_SINGLE_PROVIDER')),
      created_at INTEGER NOT NULL,
      project TEXT,
      requester TEXT CHECK (requester IS NULL OR requester IN ('grok', 'codex')),
      source_fingerprint TEXT,
      changed_files INTEGER NOT NULL DEFAULT 0 CHECK (changed_files >= 0)
    );
    CREATE TABLE runtime_review_lanes (
      review_id TEXT NOT NULL REFERENCES runtime_review_barriers(review_id) ON DELETE CASCADE,
      agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
      role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'deferred', 'completed', 'failed', 'timed_out', 'stale_artifact')),
      model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
      effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
      policy_version TEXT NOT NULL CHECK (policy_version IN ('routing-v2', 'routing-v3')),
      reasons TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      degraded INTEGER NOT NULL CHECK (degraded IN (0, 1)),
      result TEXT,
      error TEXT,
      terminal_at INTEGER,
      PRIMARY KEY (review_id, agent, role)
    );
    CREATE TABLE runtime_review_lane_attempts (
      review_id TEXT NOT NULL,
      agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex')),
      role TEXT NOT NULL CHECK (role IN ('auditor', 'critic')),
      attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 0),
      attempt_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'provider_unavailable', 'failed', 'timed_out', 'needs_reconciliation')),
      model TEXT NOT NULL CHECK (model IN ('grok-4.6', 'gpt-5.6-sol')),
      effort TEXT NOT NULL CHECK (effort IN ('high', 'xhigh')),
      policy_version TEXT NOT NULL CHECK (policy_version IN ('routing-v2', 'routing-v3')),
      reasons TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      terminal_at INTEGER,
      PRIMARY KEY (review_id, agent, role, attempt_ordinal),
      FOREIGN KEY (review_id, agent, role)
        REFERENCES runtime_review_lanes(review_id, agent, role) ON DELETE CASCADE
    );
  `);
  db.prepare(`INSERT INTO runtime_review_barriers
    (review_id,stage_id,artifact,artifact_hash,approval_scope,idempotency_key,
     run_state,created_at,project,requester,source_fingerprint,changed_files)
    VALUES ('legacy-review','review',X'01',?,'workspace-read','legacy-review',
            'FULL_CROSS_PROVIDER',10,NULL,'codex',NULL,1)`).run(frozenArtifactHash);
  for (const agent of ["grok", "codex"] as const) {
    for (const role of ["auditor", "critic"] as const) {
      const effort = role === "auditor" ? "high" : "xhigh";
      const model = agent === "grok" ? "grok-4.6" : "gpt-5.6-sol";
      const session = `${agent}-${role}-v3`;
      const idempotency = `legacy-review:${agent}:${role}`;
      const reasons = JSON.stringify([`stage_baseline:${role === "auditor" ? "code_audit" : "code_critic"}:${effort}`]);
      db.prepare(`INSERT INTO runtime_review_lanes
        (review_id,agent,role,status,model,effort,policy_version,reasons,session_id,
         idempotency_key,prompt,degraded,result,error,terminal_at)
        VALUES ('legacy-review',?,?,'queued',?,?,'routing-v3',?,?,?,'review',0,NULL,NULL,NULL)`)
        .run(agent, role, model, effort, reasons, session, idempotency);
      db.prepare(`INSERT INTO runtime_review_lane_attempts
        (review_id,agent,role,attempt_ordinal,attempt_id,status,model,effort,policy_version,
         reasons,session_id,idempotency_key,result,error,created_at,terminal_at)
        VALUES ('legacy-review',?,?,0,?,'scheduled',?,?,'routing-v3',?,?,?,NULL,NULL,10,NULL)`)
        .run(agent, role, `${idempotency}:attempt:0`, model, effort, reasons, session, idempotency);
    }
  }
  db.close();
};

describe("MAP-004C routing-v4 harness authority", () => {
  it("pins every delivery stage to Codex and never promotes Grok to stage owner", () => {
    expect(ROUTING_POLICY_VERSION).toBe("routing-v4");
    expect(STAGES.every((stage) => STAGE_POLICY[stage].preferredAgent === "codex")).toBe(true);
    expect(providerSupportsApprovalScope("grok", "workspace-read")).toBe(false);
    expect(providerSupportsApprovalScope("grok", "workspace-write")).toBe(false);
    expect(providerSupportsApprovalScope("grok", "external")).toBe(false);
    for (const stage of STAGES) {
      expect(selectStageAssignment({
        stage,
        origin: "grok",
        health: { grok: "healthy", codex: "healthy" },
        trustedInputs: { artifactBytes: 1_024, changedFiles: 2, attemptOrdinal: 0,
          approvalScope: "workspace-read" },
      })).toMatchObject({ agent: "codex", policyVersion: "routing-v4", degraded: false });
      expect(() => selectStageAssignment({
        stage,
        origin: "codex",
        health: { grok: "healthy", codex: "unavailable" },
        trustedInputs: { artifactBytes: 1_024, changedFiles: 2, attemptOrdinal: 0,
          approvalScope: "workspace-read" },
      })).toThrow(/no healthy provider/i);
    }
  });

  it("rejects mutation authority at the review-domain boundary", () => {
    expect(() => createReviewPlan({
      stageId: "review",
      artifact: Buffer.from("frozen packet"),
      health: { grok: "healthy", codex: "healthy" },
      approvalScope: "workspace-write",
      idempotencyKey: "review:write",
      prompts: { auditor: "audit", critic: "critic" },
    })).toThrow(/review.*workspace-read|read-only/i);
  });

  it("accepts only an exact broker-bound runner receipt for a Codex outage", () => {
    const root = makeRoot("broker-receipt");
    const database = join(root, "state.db");
    initializeCurrentExecutionSchema(database);
    const runtime = new CollaborationRuntime(database);
    const runs = new RunStore(database);
    const coordination = runtime.createAndStart("wf", makeRun(root), 1).activeStage!;
    expect(runtime.drainDispatchOutbox(runs, 2)).toBe(1);
    const coordinationSuccess = persistRunnerOutcome(runs, "wf", coordination, "success", 2);
    const running = runtime.recordRunnerOutcome("wf", coordinationSuccess.receipt, 2);
    expect(runtime.drainDispatchOutbox(runs, 4)).toBe(1);
    const active = running.activeStage!;
    expect(active.assignment.agent).toBe("codex");
    const { claimed, receipt: valid } = persistRunnerOutcome(runs, "wf", active, "network_timeout", 5);
    for (const forged of [
      { ...valid, schemaVersion: "runner-outcome/v0" },
      { ...valid, runId: `${claimed.id}:forged` },
      { ...valid, runAttemptCount: claimed.attemptCount + 1 },
      { ...valid, dispatchId: "wf:dispatch:999" },
      { ...valid, workflowId: "other-workflow" },
      { ...valid, stageId: "other-stage" },
      { ...valid, sessionId: "22222222-2222-4222-8222-222222222222" },
      { ...valid, agent: "grok", model: "grok-4.6" },
      { ...valid, model: "grok-4.6" },
      { ...valid, policyVersion: "routing-v3" },
      { ...valid, attemptId: `${active.assignment.attemptId}:stale` },
      { ...valid, attemptOrdinal: active.assignment.attemptOrdinal + 1 },
      { ...valid, resultKind: "probing" },
    ]) {
      expect(() => runtime.recordRunnerOutcome("wf", forged, 3)).toThrow();
    }
    const blocked = runtime.recordRunnerOutcome("wf", valid, 3);
    expect(blocked).toMatchObject({ status: "blocked_no_provider",
      blockedReason: "codex_stage_owner_unavailable", activeStage: null, pendingStageId: "planning" });
    expect(blocked.failedAttempts).toHaveLength(1);
    expect(blocked.dispatches).toHaveLength(running.dispatches.length);
    runtime.close();
    runs.close();
  });

  it.each(["permission_denial", "safety_denial"] as const)(
    "keeps %s terminal without handoff, retry dispatch, or completion promotion",
    (resultKind) => {
      const root = makeRoot(`terminal-${resultKind}`);
      const database = join(root, "state.db");
      initializeCurrentExecutionSchema(database);
      const runtime = new CollaborationRuntime(database);
      const runs = new RunStore(database);
      const active = runtime.createAndStart("wf", makeRun(root), 1).activeStage!;
      expect(runtime.drainDispatchOutbox(runs, 2)).toBe(1);
      const { receipt } = persistRunnerOutcome(runs, "wf", active, resultKind, 3);
      const stopped = runtime.recordRunnerOutcome("wf", receipt, 3);
      expect(stopped).toMatchObject({ status: "terminal_outcome" });
      expect(stopped.terminalOutcome).toEqual({ kind: resultKind });
      expect(stopped.dispatches).toHaveLength(1);
      expect(stopped.completedStageIds).toEqual([]);
      runtime.close();
      runs.close();
    },
  );

  it("fail-closes genuine frozen routing-v3 bytes without reusing their identity", () => {
    const legacy = frozenV3Run(makeRoot("legacy-restore"));
    const restored = restoreCollaborationRun(JSON.stringify(legacy));
    expect(restored).toMatchObject({ policyVersion: "routing-v3", status: "blocked_policy_upgrade",
      blockedReason: "routing_policy_upgrade_requires_replan", activeStage: null, pendingStageId: null });
    expect(restored.dispatches).toEqual(legacy.dispatches);
    expect(restored.conflict).toMatchObject({ kind: "routing_policy_upgrade", from: "routing-v3",
      to: "routing-v4", requiresNewWorkflowIdentity: true });
  });
});

describe("MAP-004C durable v4 authority", () => {
  it("rejects legacy durable workflow bytes without runtime mutation", () => {
    const root = makeRoot("legacy-outbox");
    const database = join(root, "state.db");
    initializeCurrentExecutionSchema(database);
    seedFrozenV3Workflow(database, root);
    const before = new Database(database, { readonly: true });
    const persisted = before.prepare(
      "SELECT state_json FROM collaboration_runs WHERE workflow_id='legacy'",
    ).pluck().get() as string;
    const disposition = before.prepare(`SELECT published_at, terminal_reason
      FROM collaboration_dispatch_outbox WHERE dispatch_id='legacy:dispatch:1'`)
      .get() as { published_at: number | null; terminal_reason: string | null };
    before.close();
    expect(() => new CollaborationRunStore(database)).toThrow(/offline routing-v4 migration/i);
    const unchanged = new Database(database, { readonly: true });
    expect(unchanged.prepare("SELECT state_json FROM collaboration_runs WHERE workflow_id='legacy'")
      .pluck().get()).toBe(persisted);
    expect(unchanged.prepare(`SELECT published_at, terminal_reason
      FROM collaboration_dispatch_outbox WHERE dispatch_id='legacy:dispatch:1'`).get())
      .toEqual(disposition);
    unchanged.close();
  });

  it("keeps runner fallback disabled on initial and broker-controlled retry dispatches", () => {
    const root = makeRoot("runtime-no-fallback");
    const database = join(root, "state.db");
    initializeCurrentExecutionSchema(database);
    const runtime = new CollaborationRuntime(database);
    const runs = new RunStore(database);
    const coordination = runtime.createAndStart("wf", makeRun(root), 1).activeStage!;
    expect(runtime.drainDispatchOutbox(runs, 2)).toBe(1);
    expect(runs.getByIdempotencyKey("wf:dispatch:0")?.payload?.allowFallback).toBe(false);
    const coordinationSuccess = persistRunnerOutcome(runs, "wf", coordination, "success", 3);
    const planning = runtime.recordRunnerOutcome("wf", coordinationSuccess.receipt, 3).activeStage!;
    expect(runtime.drainDispatchOutbox(runs, 4)).toBe(1);
    const { receipt } = persistRunnerOutcome(runs, "wf", planning, "network_timeout", 5);
    const blocked = runtime.recordRunnerOutcome("wf", receipt, 5);
    const firstDue = blocked.recovery!.nextRetryAt!;
    const stillBlocked = runtime.retryBlockedStage("wf", firstDue);
    expect(stillBlocked).toMatchObject({ status: "blocked_no_provider", activeStage: null });
    expect(stillBlocked.dispatches).toHaveLength(blocked.dispatches.length);
    expect(runtime.workflows.pendingDispatches()).toEqual([]);
    const secondDue = stillBlocked.recovery!.nextRetryAt!;
    const afterHealth = runtime.recordProviderHealth("wf", "codex", "healthy", secondDue - 1);
    expect(afterHealth.dispatches).toHaveLength(blocked.dispatches.length);
    expect(afterHealth.status).toBe("blocked_no_provider");
    expect(runtime.workflows.pendingDispatches()).toEqual([]);
    const retried = runtime.retryBlockedStage("wf", secondDue);
    expect(retried).toMatchObject({ status: "running", activeStage: {
      assignment: { agent: "codex", attemptOrdinal: 1 },
    } });
    expect(runtime.drainDispatchOutbox(runs, secondDue + 1)).toBe(1);
    expect(runs.getByIdempotencyKey("wf:dispatch:2")?.payload?.allowFallback).toBe(false);
    runtime.close();
    runs.close();
  });

  it("rejects frozen routing-v3 review SQL without runtime mutation", () => {
    const root = makeRoot("review-v3");
    const database = join(root, "state.db");
    seedFrozenV3Review(database);
    const before = new Database(database, { readonly: true });
    const rows = before.prepare("SELECT * FROM runtime_review_lanes ORDER BY agent,role").all();
    before.close();
    expect(() => new RunGateUnitOfWork(database)).toThrow(/current routing-v4 schema/i);
    const unchanged = new Database(database, { readonly: true });
    expect(unchanged.prepare("SELECT * FROM runtime_review_lanes ORDER BY agent,role").all()).toEqual(rows);
    unchanged.close();
  });

  it("fences legacy Grok leases and denies every Grok/cross-provider writer path", async () => {
    const root = makeRoot("lease-v4");
    const database = join(root, "state.db");
    const schema = new WorktreeLeaseStore(database);
    schema.close();
    const sqlite = new Database(database);
    sqlite.prepare(`INSERT INTO worktree_leases
      (worktree_path,task_id,lease_id,holder,fencing_token,expires_at,authority_policy)
      VALUES (?,?,?,?,?,?,'routing-v3')`).run(root, "legacy-task", "legacy-grok", "grok", 7, 99_999);
    sqlite.close();
    const store = new WorktreeLeaseStore(database);
    const fenced = await store.get(root);
    expect(fenced).toMatchObject({ holder: "grok", fencingToken: 8 });
    expect(fenced!.expiresAt).toBeLessThanOrEqual(Date.now());
    expect(await store.listHandoffs("legacy-task")).toContainEqual({
      kind: "routing_policy_fence", from: "grok", policyVersion: "routing-v4",
      previousLeaseId: "legacy-grok", fencingToken: 8, recordedAt: expect.any(Number),
    });
    await expect(store.acquire({ worktreePath: join(root, "grok-new"), taskId: "grok-new",
      holder: "grok", now: Date.now(), ttlMs: 30_000 }))
      .rejects.toThrow(/codex.*sole writer|grok.*writer/i);
    await expect(store.reuse({
      lease: { worktreePath: root, taskId: "legacy-task", leaseId: "legacy-grok",
        holder: "grok", fencingToken: 8, expiresAt: fenced!.expiresAt },
      taskId: "legacy-task", holder: "grok", now: Date.now(), ttlMs: 30_000,
    })).rejects.toThrow(/codex.*sole writer|grok.*writer/i);
    await expect(store.renew({ worktreePath: root, leaseId: "legacy-grok", fencingToken: 8,
      holder: "grok", now: Date.now(), ttlMs: 30_000 }))
      .rejects.toThrow(/codex.*sole writer|grok.*writer/i);
    expect((store as unknown as { transfer?: unknown }).transfer).toBeUndefined();
    const codex = await store.acquire({ worktreePath: root, taskId: "fresh-codex", holder: "codex",
      now: Date.now() + 1, ttlMs: 30_000 });
    expect(codex).toMatchObject({ status: "acquired", lease: { holder: "codex", fencingToken: 9 } });
    if (codex.status !== "acquired") throw new Error("expected fresh Codex lease");
    await expect(store.release({ worktreePath: root, leaseId: "legacy-grok",
      fencingToken: 7, holder: "grok" }))
      .resolves.toMatchObject({ status: "fenced", currentFencingToken: 9 });
    store.close();
  });
});
