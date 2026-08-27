import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationRuntime } from "../src/runtime/collaboration-runtime.js";
import { RunStore, type RunRecord } from "../src/store/run-store.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import {
  createCurrentMapLearningLaunchBinding,
  formatMapLearningLaunchBindingContext,
} from "../src/flow/map-admin.js";
import {
  createCollaborationRun,
  type ActiveStage,
  type AttemptAssignment,
} from "../src/workflow/workflow.js";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";

const roots: string[] = [];
const codexLearning = createCurrentMapLearningLaunchBinding("codex");
const learningContext = formatMapLearningLaunchBindingContext(codexLearning);

const makeRoot = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `agent-collab-runtime-${label}-`));
  roots.push(root);
  initializeCurrentExecutionSchema(join(root, "state.db"));
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (root: string) => {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const workspace = captureWorkspaceFingerprint(project);
  return createCollaborationRun({
  taskId: `scope:${project}:task`,
  origin: "grok",
  health: { grok: "healthy", codex: "healthy" },
  stages: [
    {
      id: "planning",
      kind: "code_review",
      role: "stage-owner",
      artifactRef: "artifact:a",
      artifactHash: "a".repeat(64),
      artifactBytes: 2_048,
      changedFiles: workspace.changedFiles.length,
      approvalScope: "workspace-read",
      idempotencyKey: "scoped:planning",
      project,
      prompt: `${learningContext}\n\nplan`,
      requester: "codex",
      sourceFingerprint: workspace.fingerprint,
      mapLearning: codexLearning,
    },
    {
      id: "review",
      kind: "code_review",
      role: "stage-owner",
      artifactRef: "artifact:a",
      artifactHash: "a".repeat(64),
      artifactBytes: 2_048,
      changedFiles: workspace.changedFiles.length,
      approvalScope: "workspace-read",
      idempotencyKey: "scoped:review",
      project,
      prompt: `${learningContext}\n\nreview`,
      requester: "codex",
      sourceFingerprint: workspace.fingerprint,
      mapLearning: codexLearning,
    },
  ],
  });
};

const receiptFor = (
  workflowId: string,
  active: ActiveStage,
  resultKind: string,
  run: RunRecord,
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
});

const persistOutcome = (
  runtime: CollaborationRuntime,
  runs: RunStore,
  workflowId: string,
  active: ActiveStage,
  resultKind: "success" | "network_timeout" | "permission_denial",
  now: number,
) => {
  const claimed = runs.claimNext({ workerId: "test-broker", leaseMs: 30_000, now: Date.now() + 1_000 });
  if (!claimed?.leaseToken) throw new Error("expected a claimed durable run");
  const receipt = receiptFor(workflowId, active, resultKind, claimed);
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
    providerResult: { kind: resultKind, agent: "codex" },
    effect: {
      type: "workflow",
      workflowId,
      stageId: active.id,
      assignment: active.assignment,
      agent: "codex",
      resultKind,
      terminalAt: now,
      runnerReceipt: receipt,
    },
    status: resultKind === "success" || resultKind === "network_timeout" ? "completed" : "failed",
  });
  return { claimed, receipt, state: runtime.recordRunnerOutcome(workflowId, receipt, now) };
};

const completeCoordination = (
  runtime: CollaborationRuntime,
  runs: RunStore,
  workflowId: string,
  active: ActiveStage,
  now = 2,
) => persistOutcome(runtime, runs, workflowId, active, "success", now).state;

describe("routing-v5 collaboration runtime and transactional outbox", () => {
  it("rejects a workflow without an exact durable MAP learning snapshot before persistence", () => {
    const root = makeRoot("missing-map-learning");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    try {
      const invalid = fixture(root) as unknown as {
        stages: Array<{ mapLearning?: unknown }>;
      };
      for (const stage of invalid.stages) delete stage.mapLearning;
      expect(() => runtime.createAndStart("wf", invalid as never, 1))
        .toThrow(/MAP learning.*missing|exact MAP learning/i);
      expect(runtime.workflows.get("wf")).toBeNull();
      expect(runtime.workflows.pendingDispatches()).toEqual([]);
    } finally {
      runtime.close();
    }
  });

  it("quarantines an outbox dispatch whose durable MAP learning snapshot is missing", () => {
    const root = makeRoot("missing-outbox-map-learning");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      runtime.createAndStart("wf", fixture(root), 1);
      const sqlite = new Database(db);
      try {
        const row = sqlite.prepare(`SELECT dispatch_id,payload_json
          FROM collaboration_dispatch_outbox WHERE published_at IS NULL`).get() as {
            dispatch_id: string;
            payload_json: string;
          };
        const payload = JSON.parse(row.payload_json) as {
          stage: { mapLearning?: unknown };
        };
        delete payload.stage.mapLearning;
        sqlite.prepare(`UPDATE collaboration_dispatch_outbox SET payload_json=?
          WHERE dispatch_id=?`).run(JSON.stringify(payload), row.dispatch_id);
      } finally {
        sqlite.close();
      }

      expect(runtime.drainDispatchOutbox(runs, 2)).toBe(0);
      expect(runs.list()).toEqual([]);
      expect(runtime.workflows.pendingDispatches()).toEqual([]);
      expect(runtime.workflows.get("wf")).toMatchObject({
        status: "terminal_outcome",
        blockedReason: "broker_dispatch_rejected_before_launch",
      });
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("round-trips the exact MAP learning snapshot through workflow state and outbox recovery", () => {
    const root = makeRoot("map-learning-roundtrip");
    const db = join(root, "state.db");
    const first = new CollaborationRuntime(db);
    const expected = fixture(root);
    first.createAndStart("wf", expected, 1);
    first.close();

    const recovered = new CollaborationRuntime(db);
    try {
      const durable = recovered.workflows.get("wf")!;
      const pending = recovered.workflows.pendingDispatches();
      expect(durable.stages.map(({ mapLearning }) => mapLearning)).toEqual(
        expected.stages.map(({ mapLearning }) => mapLearning),
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.stage.mapLearning).toEqual(durable.activeStage?.mapLearning);
    } finally {
      recovered.close();
    }
  });

  it.each([
    ["malformed JSON", (payload: string) => `${payload.slice(0, 8)}{`],
    ["valid JSON null", () => "null"],
    ["forged stage id", (payload: string) => {
      const decoded = JSON.parse(payload) as { stage: Record<string, unknown> };
      return JSON.stringify({ ...decoded, stage: { ...decoded.stage, id: "forged-stage" } });
    }],
  ])("quarantines %s from trusted outbox identity without orphaning the workflow", (_label, corrupt) => {
    const root = makeRoot("outbox-poison"); const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db); const runs = new RunStore(db);
    try {
      runtime.createAndStart("wf", fixture(root), 1);
      const sqlite = new Database(db);
      const row = sqlite.prepare("SELECT dispatch_id,payload_json FROM collaboration_dispatch_outbox")
        .get() as { dispatch_id: string; payload_json: string };
      sqlite.prepare("UPDATE collaboration_dispatch_outbox SET payload_json=? WHERE dispatch_id=?")
        .run(corrupt(row.payload_json), row.dispatch_id); sqlite.close();
      expect(runtime.drainDispatchOutbox(runs, 2)).toBe(0);
      expect(runtime.workflows.pendingDispatches()).toEqual([]);
      expect(runtime.workflows.get("wf")).toMatchObject({ status: "terminal_outcome",
        blockedReason: "broker_dispatch_rejected_before_launch", activeStage: null });
      expect(runs.list()).toEqual([]);
    } finally { runtime.close(); runs.close(); }
  });

  it("rejects a gated workflow before persistence when MAP admission evidence is absent", () => {
    const root = makeRoot("map-admission-bypass");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const gated = fixture(root);
    gated.stages.find((stage) => stage.id === "planning")!.kind = "planning";
    try {
      expect(() => runtime.createAndStart("wf", gated, 1)).toThrow(/MAP admission proof/i);
      expect(runtime.workflows.get("wf")).toBeNull();
    } finally {
      runtime.close();
    }
  });

  it("publishes Codex-owned stages with immutable decisions and fallback disabled", () => {
    const root = makeRoot("dispatch");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const initial = runtime.createAndStart("wf", fixture(root), 1);
      expect(initial.activeStage?.assignment).toMatchObject({
        agent: "codex",
        model: "gpt-5.6-sol",
        policyVersion: "routing-v5",
        attemptOrdinal: 0,
      });
      expect(runtime.drainDispatchOutbox(runs, 2)).toBe(1);
      const coordinationRun = runs.list()[0]!;
      expect(coordinationRun.payload?.workflowDispatchIdentity).toEqual(initial.activeStage!.assignment);
      expect(coordinationRun.payload?.allowFallback).toBe(false);

      const planning = completeCoordination(runtime, runs, "wf", initial.activeStage!, 3);
      expect(planning.activeStage).toMatchObject({
        id: "planning",
        assignment: { agent: "codex", policyVersion: "routing-v5" },
      });
      expect(runtime.drainDispatchOutbox(runs, 4)).toBe(1);
      expect(runs.getByIdempotencyKey("wf:dispatch:1")?.payload?.workflowDispatchIdentity)
        .toEqual(planning.activeStage!.assignment);
      expect(runs.getByIdempotencyKey("wf:dispatch:1")?.payload?.allowFallback).toBe(false);
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("replays an unacknowledged exact outbox dispatch without duplicating the queue command", () => {
    const root = makeRoot("replay");
    const db = join(root, "state.db");
    const first = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    first.createAndStart("wf", fixture(root), 1);
    expect(first.drainDispatchOutbox(runs, 2)).toBe(1);
    const original = structuredClone(runs.list()[0]);
    first.close();

    const sqlite = new Database(db);
    sqlite.prepare("UPDATE collaboration_dispatch_outbox SET published_at=NULL").run();
    sqlite.close();
    const recovered = new CollaborationRuntime(db);
    try {
      expect(recovered.drainDispatchOutbox(runs, 3)).toBe(1);
      expect(runs.list()).toEqual([original]);
      expect(recovered.workflows.pendingDispatches()).toEqual([]);
    } finally {
      recovered.close();
      runs.close();
    }
  });

  it("quarantines an idempotency collision without leaving poison in the outbox", () => {
    const root = makeRoot("collision");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      runtime.createAndStart("wf", fixture(root), 1);
      runtime.createAndStart("z-workflow", fixture(root), 1);
      runs.enqueue({
        idempotencyKey: "wf:dispatch:0",
        stage: "coordination",
        priority: 0,
        payload: { workflowDispatchIdentity: { attemptId: "forged" } },
      });
      expect(runtime.drainDispatchOutbox(runs, 2)).toBe(1);
      expect(runtime.workflows.pendingDispatches()).toEqual([]);
      expect(runtime.workflows.get("wf")).toMatchObject({
        status: "terminal_outcome",
        blockedReason: "broker_dispatch_rejected_before_launch",
      });
      expect(runs.getByIdempotencyKey("z-workflow:dispatch:0")).toBeDefined();
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("admits a failover-class outcome only through an exact launched runner receipt", () => {
    const root = makeRoot("receipt");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const { receipt, state } = persistOutcome(runtime, runs, "wf", active, "network_timeout", 100);
      expect(state).toMatchObject({
        status: "blocked_no_provider",
        blockedReason: "codex_stage_owner_unavailable",
        pendingStageId: active.id,
        activeStage: null,
        health: { codex: "unavailable" },
      });
      expect(state.failedAttempts).toHaveLength(1);
      expect(() => runtime.recordRunnerOutcome("wf", { ...receipt, runAttemptCount: 999 }, 101))
        .toThrow(/no active workflow stage|runner receipt/i);
      expect(runtime.drainDispatchOutbox(runs, 102)).toBe(0);
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("admits success only through the same exact launched runner receipt", () => {
    const root = makeRoot("success-receipt");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const { receipt, state } = persistOutcome(runtime, runs, "wf", active, "success", 3);
      expect(state.completedStageIds).toContain(active.id);
      expect(state.activeStage).toMatchObject({
        id: "planning",
        assignment: { agent: "codex", policyVersion: "routing-v5" },
      });
      expect(() => runtime.recordRunnerOutcome("wf", receipt, 4))
        .toThrow(/runner receipt|active workflow stage/i);
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("retries a blocked stage through the broker only after Codex health recovery", () => {
    const root = makeRoot("retry");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const oldAssignment = structuredClone(active.assignment);
      persistOutcome(runtime, runs, "wf", active, "network_timeout", 100);

      expect(runtime.retryBlockedStage("wf", 1_100).status).toBe("blocked_no_provider");
      runtime.recordProviderHealth("wf", "codex", "healthy", 1_101);
      const recovered = runtime.retryBlockedStage("wf", 3_100);
      expect(recovered.activeStage?.assignment).toMatchObject({
        agent: "codex",
        attemptOrdinal: 1,
        reasons: ["stage_baseline:coordination:medium", "retry"],
      });
      expect(runtime.dispatchDisposition("wf", active.id, oldAssignment)).toBe("superseded");
      expect(runtime.dispatchDisposition("wf", active.id, recovered.activeStage!.assignment)).toBe("execute");
      expect(runtime.drainDispatchOutbox(runs, 3_101)).toBe(1);
      expect(runs.getByIdempotencyKey("wf:dispatch:1")?.payload?.allowFallback).toBe(false);
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("does not publish downstream work after an admitted terminal outcome", () => {
    const root = makeRoot("terminal");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const terminal = persistOutcome(runtime, runs, "wf", active, "permission_denial", 3).state;
      expect(terminal.status).toBe("terminal_outcome");
      expect(runtime.dispatchDisposition("wf", active.id, active.assignment)).toBe("terminal");
      expect(runtime.drainDispatchOutbox(runs, 4)).toBe(0);
      expect(runs.list()).toHaveLength(1);
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("exposes explicit fail-closed broker transitions for missing runner evidence", () => {
    const root = makeRoot("broker-blocks");
    const runtime = new CollaborationRuntime(join(root, "state.db"));
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      const blocked = runtime.blockRunnerReconciliation("wf", active.id, "run-1", 2);
      expect(blocked.status).toBe("blocked_reconciliation");
      expect(runtime.dispatchDisposition("wf", active.id, active.assignment)).toBe("terminal");
    } finally {
      runtime.close();
    }

    const secondDatabase = join(root, "second.db");
    initializeCurrentExecutionSchema(secondDatabase);
    const second = new CollaborationRuntime(secondDatabase);
    const secondRuns = new RunStore(secondDatabase);
    try {
      const active = second.createAndStart("wf", fixture(root), 1).activeStage!;
      second.drainDispatchOutbox(secondRuns, 1);
      const claimed = secondRuns.claimNext({ workerId: "prelaunch", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
      const receipt = { schemaVersion: "prelaunch-outcome/v1", runId: claimed.id,
        runAttemptCount: claimed.attemptCount, dispatchId: claimed.idempotencyKey, workflowId: "wf",
        stageId: active.id, attemptId: active.assignment.attemptId,
        attemptOrdinal: active.assignment.attemptOrdinal, agent: active.assignment.agent,
        model: active.assignment.model, policyVersion: active.assignment.policyVersion,
        sessionId: active.assignment.sessionId, resultKind: "invalid_request" };
      secondRuns.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!,
        providerResult: { kind: "invalid_request", agent: "codex" },
        effect: { type: "workflow_dispatch_rejected", workflowId: "wf", stageId: active.id,
          runId: claimed.id, reason: "invalid_request", prelaunchReceipt: receipt, terminalAt: 2 },
        status: "failed" });
      const rejected = second.recordPrelaunchOutcome("wf", receipt, 2);
      expect(rejected).toMatchObject({
        status: "terminal_outcome",
        terminalOutcome: { kind: "invalid_request" },
      });
      expect(second.dispatchDisposition("wf", active.id, active.assignment)).toBe("terminal");
    } finally {
      second.close();
      secondRuns.close();
    }
  });

  it("routes an exact prelaunch provider outage into bounded owner retry", () => {
    const root = makeRoot("prelaunch-retry");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 1);
      const claimed = runs.claimNext({ workerId: "prelaunch", leaseMs: 1_000,
        now: Date.now() + 1_000 })!;
      const receipt = { schemaVersion: "prelaunch-outcome/v1", runId: claimed.id,
        runAttemptCount: claimed.attemptCount, dispatchId: claimed.idempotencyKey, workflowId: "wf",
        stageId: active.id, attemptId: active.assignment.attemptId,
        attemptOrdinal: active.assignment.attemptOrdinal, agent: active.assignment.agent,
        model: active.assignment.model, policyVersion: active.assignment.policyVersion,
        sessionId: active.assignment.sessionId, resultKind: "cli_missing" };
      runs.commitDomainEffect({ id: claimed.id, token: claimed.leaseToken!,
        providerResult: { kind: "cli_missing", agent: "codex" },
        effect: { type: "workflow_dispatch_rejected", workflowId: "wf", stageId: active.id,
          runId: claimed.id, reason: "cli_missing", prelaunchReceipt: receipt, terminalAt: 2 },
        status: "completed" });
      expect(runtime.recordPrelaunchOutcome("wf", receipt, 2)).toMatchObject({
        status: "blocked_no_provider",
        pendingStageId: active.id,
        recovery: { attempt: 0, nextRetryAt: 1002 },
      });
    } finally { runtime.close(); runs.close(); }
  });

  it("rejects a stale completion after the active attempt is blocked", () => {
    const root = makeRoot("stale");
    const db = join(root, "state.db");
    const runtime = new CollaborationRuntime(db);
    const runs = new RunStore(db);
    try {
      const active = runtime.createAndStart("wf", fixture(root), 1).activeStage!;
      runtime.drainDispatchOutbox(runs, 2);
      const { receipt } = persistOutcome(runtime, runs, "wf", active, "network_timeout", 100);
      expect(() => runtime.recordRunnerOutcome("wf", { ...receipt, resultKind: "success" }, 101))
        .toThrow(/runner receipt|active workflow stage/i);
      expect(runtime.workflows.get("wf")?.completedStageIds).not.toContain(active.id);
    } finally {
      runtime.close();
      runs.close();
    }
  });

  it("rejects a workflow-id collision when immutable trusted inputs differ", () => {
    const root = makeRoot("identity");
    const db = join(root, "state.db");
    const first = new CollaborationRuntime(db);
    const second = new CollaborationRuntime(db);
    try {
      first.createAndStart("wf", fixture(root), 1);
      const conflicting = fixture(root);
      conflicting.stages[1]!.changedFiles = 99;
      expect(() => second.createAndStart("wf", conflicting, 2))
        .toThrow("workflow id conflicts with immutable collaboration input");
    } finally {
      first.close();
      second.close();
    }
  });

  it("treats missing aggregates and mismatched assignments as non-executable", () => {
    const root = makeRoot("disposition");
    const runtime = new CollaborationRuntime(join(root, "state.db"));
    try {
      const state = runtime.createAndStart("wf", fixture(root), 1);
      const assignment = state.activeStage!.assignment;
      const forged: AttemptAssignment = { ...assignment, attemptId: `${assignment.attemptId}:forged` };
      expect(runtime.dispatchDisposition("wf", state.activeStage!.id, forged)).toBe("superseded");
      expect(runtime.dispatchDisposition("missing", state.activeStage!.id, assignment)).toBe("terminal");
    } finally {
      runtime.close();
    }
  });
});
