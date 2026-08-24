#!/usr/bin/env node
import { accessSync, constants, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { execa } from "execa";
import { LocalCollabService } from "./app/service.js";
import type { ProviderOutcome } from "./domain/outcomes.js";
import type { ActiveAgentId, ProviderHealthSnapshot } from "./domain/routing.js";
import { doctorV1, MigrationCoordinator, prepareRollbackBundle, restoreV1Bundle, verifyBundle } from "./migration/coordinator.js";
import { startStdioCollabServer } from "./mcp/server.js";
import { AgentRunner, type ProcessTask } from "./runners/agent-runner.js";
import { captureWorkspaceFingerprint } from "./runtime/workspace-fingerprint.js";
import { CollaborationRuntime } from "./runtime/collaboration-runtime.js";
import { ProviderHealthStore } from "./runtime/provider-health-store.js";
import { ReviewBarrierStore, type LaneEnqueueDescriptor } from "./runtime/review-barrier-store.js";
import { defaultAllowedProjectRoots, ProjectPolicy } from "./security/project-policy.js";
import { runCapabilityProbes } from "./probes/capability-probe.js";
import { ensureStateLayout } from "./store/state-layout.js";
import { RunStore, type RunRecord } from "./store/run-store.js";
import { DurableWorker } from "./worker/durable-worker.js";
import { WorktreeLeaseStore, type WorktreeLease } from "./worktree/lease-store.js";
import type { AttemptAssignment, CheckpointEvidence, ObservedWorktree } from "./workflow/workflow.js";

const stateRoot = process.env.AGENT_COLLAB_STATE_DIR ?? join(homedir(), ".local", "share", "agent-collab");
const layout = ensureStateLayout(stateRoot);
const grokBinary = process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok");
const codexBinary = process.env.AGENT_COLLAB_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
const allowedProjectRoots = defaultAllowedProjectRoots();
const command = process.argv[2] ?? "status";
const AGENTS: readonly ActiveAgentId[] = ["grok", "codex"];
const FAILOVER = new Set(["quota", "rate_limit", "overload", "network_timeout", "model_unavailable", "cli_missing", "auth"]);

const tableExists = (database: string, table: string): boolean => {
  const db = new Database(database, { readonly: true });
  try { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined; }
  finally { db.close(); }
};

const schemaVersion = (database: string): number => {
  const db = new Database(database, { readonly: true });
  try { return Number(db.pragma("user_version", { simple: true })); }
  finally { db.close(); }
};

const markV2 = (database: string): void => {
  const db = new Database(database);
  try { db.pragma("user_version = 2"); } finally { db.close(); }
};

const prepareDatabases = (): void => {
  const hasState = tableExists(layout.database, "runtime_provider_health");
  const hasHistory = tableExists(layout.historyDatabase, "sources");
  if (hasState !== hasHistory) throw new Error("state/history schema pair is incomplete; refusing automatic repair");
  if (hasState) {
    const stateVersion = schemaVersion(layout.database);
    const historyVersion = schemaVersion(layout.historyDatabase);
    if (stateVersion === 2 && historyVersion === 2) return;
    throw new Error(`offline migration required: state=${stateVersion}, history=${historyVersion}; run migrate-v2 while the service is stopped`);
  }
  const service = new LocalCollabService(layout.database, { historyDatabase: layout.historyDatabase });
  service.close();
  markV2(layout.database);
  markV2(layout.historyDatabase);
};

const assertServiceInactive = (): void => {
  const state = spawnSync("systemctl", ["--user", "is-active", "agent-collab.service"], {
    encoding: "utf8", timeout: 10_000, shell: false,
  });
  if (state.status !== 3 || state.stdout.trim() !== "inactive") {
    throw new Error(`agent-collab.service must be confirmed inactive; status=${String(state.status)} state=${state.stdout.trim() || "unknown"}`);
  }
};

if (command === "doctor-v1") {
  console.log(JSON.stringify(doctorV1({ stateDatabase: layout.database, historyDatabase: layout.historyDatabase }), null, 2));
  process.exit(0);
}

if (command === "verify-bundle") {
  console.log(JSON.stringify(verifyBundle(resolve(process.argv[3] ?? "")), null, 2));
  process.exit(0);
}

if (command === "restore-v1") {
  assertServiceInactive();
  const restored = restoreV1Bundle({ bundleDirectory: resolve(process.argv[3] ?? ""),
    stateDatabase: layout.database, historyDatabase: layout.historyDatabase });
  const doctor = doctorV1({ stateDatabase: layout.database, historyDatabase: layout.historyDatabase });
  if (!doctor.readyForMigration) throw new Error(`restored v1 bundle failed doctor: ${doctor.blockers.join(", ")}`);
  console.log(JSON.stringify({ ...restored, doctor }, null, 2));
  process.exit(0);
}

if (command === "migrate-v2") {
  assertServiceInactive();
  const rollbackParent = join(stateRoot, "rollback");
  mkdirSync(rollbackParent, { recursive: true, mode: 0o700 });
  const bundle = join(rollbackParent, `v1-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  prepareRollbackBundle({ bundleDirectory: bundle, artifacts: [
    { name: "package-lock.json", sourcePath: join(process.cwd(), "package-lock.json") },
    { name: "systemd/agent-collab.service", sourcePath: join(process.cwd(), "systemd", "agent-collab.service") },
    { name: "dist", sourcePath: join(process.cwd(), "dist") },
  ] });
  const result = new MigrationCoordinator({
    stateDatabase: layout.database,
    historyDatabase: layout.historyDatabase,
    backupDirectory: bundle,
  }).migrateToV2();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

prepareDatabases();

const requireUserApproval = (reference: string, project: string, scope: string): void => {
  const expected = `APPROVE ${reference}`;
  const message = `Agent collaboration requests ${scope} for ${project}. Type exactly: ${expected}`;
  const result = spawnSync("/usr/bin/systemd-ask-password", ["--no-tty", "--timeout=120", "--echo=yes", message],
    { encoding: "utf8", timeout: 125_000, shell: false, env: { PATH: "/usr/bin:/bin" } });
  if (result.status === 0 && result.stdout.trim() === expected) return;
  const graphical = spawnSync("/usr/bin/zenity", ["--entry", "--title=Agent collaboration approval", `--text=${message}`, "--hide-text"],
    { encoding: "utf8", timeout: 125_000, shell: false,
      env: { PATH: "/usr/bin:/bin", ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) } });
  if (graphical.status !== 0 || graphical.stdout.trim() !== expected) {
    throw new Error("approval was not confirmed through a user-bound system prompt");
  }
};

const routingHealth = (health: ProviderHealthStore, now: number): ProviderHealthSnapshot => {
  const snapshot = health.snapshot();
  return {
    grok: snapshot.grok.health,
    codex: snapshot.codex.health,
  };
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const assignmentFrom = (value: unknown): AttemptAssignment | null => {
  const input = asObject(value);
  if (!input || (input.agent !== "grok" && input.agent !== "codex") ||
      typeof input.attemptId !== "string" || typeof input.attemptOrdinal !== "number") return null;
  return input as unknown as AttemptAssignment;
};

const processTask = (run: RunRecord): ProcessTask => ({
  id: run.id,
  stage: run.stage,
  ...(run.approvalScope === undefined ? {} : { approvalScope: run.approvalScope }),
  ...(run.payload === undefined ? {} : { payload: run.payload }),
});

const enqueueReviewLane = (store: RunStore, lane: LaneEnqueueDescriptor) => store.enqueueExact({
  idempotencyKey: lane.idempotencyKey, stage: `review:${lane.role}`, priority: 5,
  artifactHash: lane.artifactHash, approvalScope: "workspace-read",
  payload: { requester: lane.requester ?? "codex", preferredAgent: lane.agent, project: lane.project,
    prompt: `${lane.prompt}\n\nImmutable artifact (${lane.artifactHash}):\n${lane.artifact.toString("utf8")}`,
    approvalScope: "workspace-read", allowFallback: false, reviewRole: lane.role,
    reviewId: lane.reviewId, sessionId: lane.sessionId, artifactHash: lane.artifactHash,
    reviewAttemptId: lane.attemptId, reviewAttemptOrdinal: lane.attemptOrdinal,
    decision: { agent: lane.agent, model: lane.model, effort: lane.effort,
      policyVersion: lane.policyVersion, reasons: lane.reasons },
    reviewDispatchIdentity: { agent: lane.agent, model: lane.model, effort: lane.effort,
      policyVersion: lane.policyVersion, reasons: lane.reasons, sessionId: lane.sessionId,
      attemptId: lane.attemptId, attemptOrdinal: lane.attemptOrdinal, degraded: lane.degraded } },
});

if (command === "reconcile-run") {
  const runId = process.argv[3] ?? "";
  const resolution = process.argv[4];
  if (resolution !== "completed" && resolution !== "failed") {
    throw new Error("reconcile-run requires <run-id> <completed|failed>");
  }
  const store = new RunStore(layout.database);
  const run = store.get(runId);
  if (!run || run.status !== "needs_reconciliation") throw new Error("run is not awaiting reconciliation");
  const decision = asObject(run.payload?.decision);
  const agent = decision?.agent;
  const reviewId = typeof run.payload?.reviewId === "string" ? run.payload.reviewId : null;
  const reviewAttemptId = typeof run.payload?.reviewAttemptId === "string" ? run.payload.reviewAttemptId : null;
  const role = run.payload?.reviewRole;
  const workflowId = typeof run.payload?.workflowId === "string" ? run.payload.workflowId : null;
  const stageId = typeof run.payload?.workflowStageId === "string" ? run.payload.workflowStageId : null;
  const assignment = assignmentFrom(run.payload?.workflowDispatchIdentity);
  let effect: Record<string, unknown>;
  if (reviewId && reviewAttemptId && (role === "auditor" || role === "critic") &&
      (agent === "grok" || agent === "codex")) {
    if (resolution === "completed") {
      store.close();
      throw new Error("review reconciliation cannot synthesize completed evidence; resolve as failed and replay a new lane");
    }
    effect = { type: "review", reviewId, attemptId: reviewAttemptId, role, agent,
      resultKind: "task_failure" };
  } else if (workflowId && stageId && assignment && (agent === "grok" || agent === "codex")) {
    const executionContext = asObject(asObject(run.launchInfo)?.executionContext);
    const lease = asObject(executionContext?.lease);
    if (!lease) { store.close(); throw new Error("workflow reconciliation is missing persisted lease identity"); }
    effect = { type: "workflow", workflowId, stageId, assignment, agent,
      resultKind: resolution === "completed" ? "success" : "task_failure", lease,
      terminalAt: Date.now() };
  } else {
    store.close(); throw new Error("reconciliation payload has no supported domain identity");
  }
  store.resolveReconciliation({ id: run.id,
    providerResult: { kind: resolution === "completed" ? "success" : "task_failure",
      reconciledByOperator: true, reconciledAt: Date.now() },
    effect: { terminalAt: Date.now(), ...effect }, status: resolution });
  console.log(JSON.stringify({ runId, resolution, domainEffect: "pending_worker_replay" }, null, 2));
  store.close(); process.exit(0);
}

if (command === "mcp") {
  const service = new LocalCollabService(layout.database, { historyDatabase: layout.historyDatabase });
  await startStdioCollabServer(service);
} else if (command === "worker") {
  const recovery = new RunStore(layout.database);
  recovery.recoverExpired(); recovery.close();
  const health = new ProviderHealthStore(layout.database, { cooldownMs: 60_000 });
  const reviews = new ReviewBarrierStore(layout.database);
  const markReviewReconciliation = (at: number): void => {
    const store = new RunStore(layout.database);
    for (const run of store.needsReconciliation()) {
      const reviewId = typeof run.payload?.reviewId === "string" ? run.payload.reviewId : null;
      const attemptId = typeof run.payload?.reviewAttemptId === "string" ? run.payload.reviewAttemptId : null;
      const role = run.payload?.reviewRole;
      const decision = asObject(run.payload?.decision);
      const agent = decision?.agent;
      if (reviewId && attemptId && (role === "auditor" || role === "critic") &&
          (agent === "grok" || agent === "codex")) {
        reviews.markAttemptNeedsReconciliation({ reviewId, agent, role, attemptId, at });
      }
    }
    store.close();
  };
  markReviewReconciliation(Date.now());
  const collaborationRuntime = new CollaborationRuntime(layout.database);
  const worktreeLeases = new WorktreeLeaseStore(layout.database);
  const startupOutbox = new RunStore(layout.database);
  collaborationRuntime.drainDispatchOutbox(startupOutbox); startupOutbox.close();

  const refreshHealth = (now: number): void => {
    for (const [agent, binary, args] of [
      ["grok", grokBinary, ["models"]], ["codex", codexBinary, ["login", "status"]],
    ] as const) {
      const state = health.get(agent);
      if (state.health === "healthy" || state.health === "disabled" ||
          (state.health === "probing" && state.updatedAt > 0) ||
          (state.retryAt !== null && state.retryAt > now) || !health.canAttempt(agent, now)) continue;
      const result = spawnSync(binary, args, { encoding: "utf8", timeout: 10_000, shell: false });
      if (result.status === 0) health.recordAuthReady(agent, now);
      else health.recordFailoverFailure(agent, {
        kind: result.error && "code" in result.error && result.error.code === "ENOENT" ? "cli_missing" : "auth",
      }, now);
    }
  };

  refreshHealth(Date.now());
  const runner = new AgentRunner({ binaries: { grok: grokBinary, codex: codexBinary }, timeoutMs: 30 * 60_000 });
  const effectStore = new RunStore(layout.database);
  const releaseRecordedLease = async (value: unknown): Promise<void> => {
    const lease = asObject(value) as unknown as WorktreeLease | null;
    if (!lease) return;
    await worktreeLeases.release({ worktreePath: lease.worktreePath, leaseId: lease.leaseId,
      fencingToken: lease.fencingToken, holder: lease.holder });
  };
  const applyDomainEffect = async (
    run: RunRecord,
    providerResult: Record<string, unknown>,
    effect: Record<string, unknown>,
  ): Promise<void> => {
    const type = effect.type;
    const terminalAt = Number(effect.terminalAt);
    if (!Number.isSafeInteger(terminalAt) || terminalAt < 0) throw new Error("invalid persisted domain-effect time");
    if (type === "workflow") {
      const workflowId = String(effect.workflowId);
      const stageId = String(effect.stageId);
      const assignment = assignmentFrom(effect.assignment);
      const agent = effect.agent;
      const resultKind = String(effect.resultKind);
      if (!assignment || (agent !== "grok" && agent !== "codex")) throw new Error("invalid persisted workflow effect");
      const disposition = collaborationRuntime.dispatchDisposition(workflowId, stageId, assignment);
      if (disposition === "execute") {
        if (resultKind === "success") {
          collaborationRuntime.completeStage(workflowId, stageId, assignment, providerResult, terminalAt);
        } else if (FAILOVER.has(resultKind)) {
          const checkpoint = effect.checkpoint as unknown as CheckpointEvidence;
          const observed = effect.observed as unknown as ObservedWorktree;
          const lease = effect.lease as unknown as WorktreeLease;
          collaborationRuntime.recordProviderOutcome(workflowId, {
            from: agent, outcome: { kind: resultKind } as ProviderOutcome,
            health: effect.health as ProviderHealthSnapshot, checkpoint, lease,
            observed, assignment, outcomeEventId: `${run.id}:${run.attemptCount}`,
          }, terminalAt);
        } else {
          collaborationRuntime.recordTerminalOutcome(
            workflowId, assignment, { kind: resultKind as ProviderOutcome["kind"] }, terminalAt,
          );
        }
      }
      const queue = new RunStore(layout.database);
      collaborationRuntime.drainDispatchOutbox(queue); queue.close();
      await releaseRecordedLease(effect.lease);
      return;
    }
    if (type === "review") {
      const reviewId = String(effect.reviewId);
      const attemptId = String(effect.attemptId);
      const role = effect.role;
      const agent = effect.agent;
      const resultKind = String(effect.resultKind);
      if ((role !== "auditor" && role !== "critic") || (agent !== "grok" && agent !== "codex")) {
        throw new Error("invalid persisted review effect");
      }
      const attempt = reviews.attempts(reviewId, agent, role).find((item) => item.attemptId === attemptId);
      if (!attempt) throw new Error("unknown persisted review attempt");
      if (attempt.status === "needs_reconciliation") {
        reviews.resolveAttemptReconciliation({ reviewId, agent, role, attemptId,
          status: resultKind === "success" ? "completed" : "failed",
          evidence: providerResult, at: terminalAt });
      } else if (attempt.status === "scheduled") {
        if (resultKind === "success") {
          reviews.recordTerminal({ reviewId, agent, role, attemptId, status: "completed",
            result: providerResult, terminalAt });
        } else if (FAILOVER.has(resultKind)) {
          reviews.recordProviderUnavailable({ reviewId, agent, role, attemptId,
            error: providerResult, terminalAt });
        } else {
          reviews.recordTerminal({ reviewId, agent, role, attemptId, status: "failed",
            error: providerResult, terminalAt });
        }
      }
      return;
    }
    throw new Error("unknown persisted domain effect");
  };
  const replayPendingDomainEffects = async (): Promise<void> => {
    for (const pending of effectStore.pendingDomainEffects()) {
      const envelope = asObject(pending.result);
      const providerResult = asObject(envelope?.providerResult);
      const effect = asObject(envelope?.effect);
      if (!providerResult || !effect) throw new Error(`invalid pending domain effect: ${pending.id}`);
      await applyDomainEffect(pending, providerResult, effect);
      effectStore.markDomainEffectApplied(pending.id);
    }
  };
  await replayPendingDomainEffects();
  const workers = Array.from({ length: 4 }, (_unused, index) => new DurableWorker({
    store: new RunStore(layout.database), workerId: `worker:${process.pid}:${index}`,
    runner: async (run, onLaunch, commitDomainEffect, persistExecutionContext) => {
      const reviewId = typeof run.payload?.reviewId === "string" ? run.payload.reviewId : null;
      const reviewAttemptId = typeof run.payload?.reviewAttemptId === "string" ? run.payload.reviewAttemptId : null;
      const role = run.payload?.reviewRole;
      const decision = asObject(run.payload?.decision);
      const agent = decision?.agent;
      if (reviewId && (role === "auditor" || role === "critic") && (agent === "grok" || agent === "codex")) {
        const existing = reviews.get(reviewId)?.lanes.find((lane) => lane.agent === agent && lane.role === role);
        if (existing && ["completed", "failed", "timed_out", "stale_artifact"].includes(existing.status)) {
          return { kind: "success", reconciledTerminalLane: true, priorStatus: existing.status, result: existing.result };
        }
      }

      const workflowId = typeof run.payload?.workflowId === "string" ? run.payload.workflowId : null;
      const workflowStageId = typeof run.payload?.workflowStageId === "string" ? run.payload.workflowStageId : null;
      const queuedAssignment = assignmentFrom(run.payload?.workflowDispatchIdentity);
      const now = Date.now();
      if (workflowId && workflowStageId && queuedAssignment) {
        const current = collaborationRuntime.workflows.get(workflowId);
        if (current?.status === "blocked_no_provider" && current.recovery !== null &&
            current.recovery.nextRetryAt !== null && current.recovery.nextRetryAt <= now) {
          const available = routingHealth(health, now);
          collaborationRuntime.workflows.applyMany(workflowId, [
            { type: "PROVIDER_HEALTH_CHANGED", agent: "grok", health: available.grok },
            { type: "PROVIDER_HEALTH_CHANGED", agent: "codex", health: available.codex },
            { type: "RECOVERY_TIMER_FIRED", eventId: `${workflowId}:recovery:${now}`, now },
          ], now);
          const queue = new RunStore(layout.database);
          collaborationRuntime.drainDispatchOutbox(queue, now); queue.close();
        }
        const disposition = collaborationRuntime.dispatchDisposition(workflowId, workflowStageId, queuedAssignment);
        if (disposition !== "execute") {
          return disposition === "terminal"
            ? { kind: "task_failure", reconciledDispatch: disposition }
            : { kind: "handoff_dispatched", reconciledDispatch: disposition };
        }
      }

      let lease: WorktreeLease | null = null;
      const project = typeof run.payload?.project === "string" ? run.payload.project : null;
      if (workflowId && project && (agent === "grok" || agent === "codex")) {
        const handedOff = asObject(run.payload?.handoffLease);
        const priorContext = asObject(asObject(run.launchInfo)?.executionContext);
        const priorLease = asObject(priorContext?.lease) as unknown as WorktreeLease | null;
        if (handedOff) lease = handedOff as unknown as WorktreeLease;
        else if (priorLease) {
          const reused = await worktreeLeases.reuse({ lease: priorLease, taskId: workflowId,
            holder: agent, now, ttlMs: 31 * 60_000 });
          if (reused.status !== "acquired") return { kind: "task_failure", error: "persisted worktree lease is fenced" };
          lease = reused.lease;
        } else {
          const acquired = await worktreeLeases.acquire({ worktreePath: project, taskId: workflowId,
            holder: agent, now, ttlMs: 31 * 60_000 });
          if (acquired.status !== "acquired") return { kind: "task_failure", error: "worktree lease is contended" };
          lease = acquired.lease;
        }
        persistExecutionContext({ lease });
      }

      const result = await runner.run(processTask(run), onLaunch);
      const resultKind = typeof result.kind === "string" ? result.kind : "task_failure";
      if ((agent === "grok" || agent === "codex") && resultKind === "success") health.recordSuccess(agent, Date.now());
      if ((agent === "grok" || agent === "codex") && FAILOVER.has(resultKind)) {
        health.recordFailoverFailure(agent, { kind: resultKind } as ProviderOutcome, Date.now());
      }

      let effect: Record<string, unknown> | null = null;
      if (workflowId && workflowStageId && queuedAssignment && (agent === "grok" || agent === "codex")) {
        effect = { type: "workflow", workflowId, stageId: workflowStageId,
          assignment: queuedAssignment, agent, resultKind, terminalAt: Date.now(), ...(lease ? { lease } : {}) };
        if (FAILOVER.has(resultKind)) {
          const active = collaborationRuntime.workflows.get(workflowId)?.activeStage;
          if (!active) throw new Error("failover workflow has no active stage");
          const observed = project ? captureWorkspaceFingerprint(project) : {
            headSha: "not-applicable", diffHash: "not-applicable", changedFiles: [], fingerprint: "not-applicable",
          };
          if (!lease) throw new Error("workflow failover requires a durable worktree lease");
          const handoffLease = lease;
          const checkpoint: CheckpointEvidence & { workspaceFingerprint: string } = {
            artifactHash: active.artifactHash, headSha: observed.headSha, diffHash: observed.diffHash,
            changedFiles: observed.changedFiles, testEvidence: [],
            sourceSessionId: typeof run.payload?.sessionId === "string" ? run.payload.sessionId : `run:${run.id}`,
            approvals: [], nextAction: { kind: "continue_stage", stageId: active.id,
              instruction: "continue from verified provider failover" }, workspaceFingerprint: observed.fingerprint,
          };
          const observedWorktree: ObservedWorktree = { artifactHash: active.artifactHash,
            headSha: observed.headSha, diffHash: observed.diffHash, leaseId: handoffLease.leaseId,
            fencingToken: handoffLease.fencingToken };
          effect = { ...effect, checkpoint, observed: observedWorktree,
            health: routingHealth(health, Date.now()), lease: handoffLease };
        }
      } else if (reviewId && reviewAttemptId && (role === "auditor" || role === "critic") &&
          (agent === "grok" || agent === "codex")) {
        effect = { type: "review", reviewId, attemptId: reviewAttemptId, role, agent,
          resultKind, terminalAt: Date.now() };
      }
      if (!effect) return result;
      commitDomainEffect({ providerResult: result, effect,
        status: resultKind === "success" || FAILOVER.has(resultKind) ? "completed" : "failed" });
      await applyDomainEffect(run, result, effect);
      effectStore.markDomainEffectApplied(run.id);
      return result;
    }, leaseMs: 31 * 60_000,
  }));

  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  let lastRecovery = 0;
  while (!stopping) {
    const now = Date.now();
    if (now - lastRecovery >= 30_000) {
      const store = new RunStore(layout.database);
      store.recoverExpired(now); store.close();
      markReviewReconciliation(now);
      await replayPendingDomainEffects();
      const outboxQueue = new RunStore(layout.database);
      collaborationRuntime.drainDispatchOutbox(outboxQueue, now); outboxQueue.close();
      refreshHealth(now);
      const available = routingHealth(health, now);
      for (const recoverable of collaborationRuntime.workflows.recoverable()) {
        const events = [
          { type: "PROVIDER_HEALTH_CHANGED" as const, agent: "grok" as const, health: available.grok },
          { type: "PROVIDER_HEALTH_CHANGED" as const, agent: "codex" as const, health: available.codex },
        ];
        const recovery = recoverable.state.recovery;
        collaborationRuntime.workflows.applyMany(recoverable.workflowId, [
          ...events,
          ...(recovery?.nextRetryAt !== null && recovery?.nextRetryAt !== undefined && recovery.nextRetryAt <= now
            ? [{ type: "RECOVERY_TIMER_FIRED" as const,
                eventId: `${recoverable.workflowId}:recovery:${recovery.attempt}:${recovery.nextRetryAt}`, now }]
            : []),
        ], now);
      }
      const recoveredQueue = new RunStore(layout.database);
      collaborationRuntime.drainDispatchOutbox(recoveredQueue, now); recoveredQueue.close();
      for (const agent of AGENTS) {
        const provider = health.get(agent);
        if (provider.health !== "healthy") continue;
        for (const reviewId of reviews.deferredReviewIds(agent)) {
          const snapshot = reviews.get(reviewId); if (!snapshot) continue;
          const currentSourceFingerprint = snapshot.project ? captureWorkspaceFingerprint(snapshot.project).fingerprint : undefined;
          const activated = reviews.activateDeferred({ reviewId, agent, currentArtifactHash: snapshot.artifactHash,
            ...(currentSourceFingerprint ? { currentSourceFingerprint } : {}), now, providerHealth: health });
          if (activated.status === "activated") {
            const queue = new RunStore(layout.database);
            for (const lane of activated.lanes) enqueueReviewLane(queue, lane);
            queue.close(); reviews.confirmDeferredEnqueued(reviewId, agent);
          }
        }
      }
      lastRecovery = now;
    }
    await Promise.all(workers.map((worker) => worker.runOnce(now)));
    await delay(500);
  }
  for (const worker of workers) worker.close();
  health.close(); reviews.close(); collaborationRuntime.close(); worktreeLeases.close(); effectStore.close();
} else {
  const service = new LocalCollabService(layout.database, { historyDatabase: layout.historyDatabase });
  if (command === "index") {
    console.log(JSON.stringify(await service.indexNow({ project: resolve(process.argv[3] ?? process.cwd()) })));
  } else if (command === "probe") {
    if (process.argv[3] !== "APPROVE_LIVE_CAPABILITY_PROBE") {
      throw new Error("live capability probing may incur provider cost; pass APPROVE_LIVE_CAPABILITY_PROBE explicitly");
    }
    const versions = {
      grok: process.env.AGENT_COLLAB_GROK_VERSION ?? "grok 1.0.5 (5115b46bc9)",
      codex: process.env.AGENT_COLLAB_CODEX_VERSION ?? "codex-cli 0.147.0",
    };
    const result = await runCapabilityProbes({
      providers: {
        grok: { enabled: true, binaryPath: grokBinary, expectedVersion: versions.grok,
          model: "grok-4.6", effort: "high", cwd: process.cwd() },
        codex: { enabled: true, binaryPath: codexBinary, expectedVersion: versions.codex,
          model: "gpt-5.6-sol", effort: "high", cwd: process.cwd() },
      },
      timeoutMs: 120_000,
      runner: {
        execute: async (request) => {
          const version = spawnSync(request.file, ["--version"], { encoding: "utf8", timeout: 10_000, shell: false });
          if (version.status !== 0) throw version.error ?? new Error(version.stderr || "version probe failed");
          const processResult = await execa(request.file, request.args, {
            cwd: request.cwd,
            input: request.stdin,
            shell: false,
            reject: false,
            timeout: request.timeoutMs,
            cleanup: true,
          });
          return { exitCode: processResult.exitCode ?? -1, version: version.stdout.trim(),
            stdout: processResult.stdout, stderr: processResult.stderr };
        },
      },
    });
    for (const agent of AGENTS) {
      if (result.results[agent].ready) service.providers.recordSuccess(agent, Date.now());
      else service.providers.recordFailoverFailure(agent, { kind: "model_unavailable" }, Date.now());
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "doctor") {
    const binaries = Object.fromEntries(([{ agent: "grok", path: grokBinary }, { agent: "codex", path: codexBinary }]).map(({ agent, path }) => {
      try { accessSync(path, constants.X_OK); return [agent, { path, executable: true }]; }
      catch { return [agent, { path, executable: false }]; }
    }));
    console.log(JSON.stringify({ protocol: "agent-collab/v2", state: layout, binaries, liveModelProbe: "not_run" }, null, 2));
  } else if (command === "approve") {
    const reference = process.argv[3]; const projectInput = process.argv[4]; const scope = process.argv[5];
    if (!reference || !projectInput || (scope !== "workspace-write" && scope !== "external")) {
      throw new Error("usage: agent-collab approve <reference> <project> <workspace-write|external> [ttlSeconds] [maxUses]");
    }
    const project = new ProjectPolicy(allowedProjectRoots).resolve(projectInput);
    const ttlSeconds = Number(process.argv[6] ?? 900); const maxUses = Number(process.argv[7] ?? 1);
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 86_400) throw new Error("ttlSeconds must be 1..86400");
    requireUserApproval(reference, project, scope);
    service.approvals.issue({ reference, project, scope, expiresAt: Date.now() + ttlSeconds * 1_000, maxUses });
    console.log(JSON.stringify({ reference, project, scope, ttlSeconds, maxUses }));
  } else if (command === "status") {
    console.log(JSON.stringify(await service.status(), null, 2));
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  service.close();
}
