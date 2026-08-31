#!/usr/bin/env node
import { accessSync, constants, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { execa } from "execa";
import { LocalCollabService } from "./app/service.js";
import { isFailoverOutcome } from "./domain/outcomes.js";
import {
  normalizeReviewProviderResult,
} from "./domain/review-verdict.js";
import {
  REVIEW_PROVIDER_IDS,
  type ProviderHealthSnapshot,
  type ReviewProviderId,
} from "./domain/routing.js";
import { doctorV1, initializeCurrentExecutionSchema, MigrationCoordinator, prepareRollbackBundle, restoreV1Bundle, verifyBundle } from "./migration/coordinator.js";
import { assertReviewV3SchemaSignature } from "./migration/review-v3-schema.js";
import { startStdioCollabServer } from "./mcp/server.js";
import { AgentRunner, type ProcessTask } from "./runners/agent-runner.js";
import { captureWorkspaceFingerprint } from "./runtime/workspace-fingerprint.js";
import { activateRecoveredReviewLanes } from "./runtime/review-rejoin.js";
import { runAutomaticProviderRecovery } from "./runtime/provider-recovery-loop.js";
import {
  CollaborationRuntime,
  RunnerOutcomeEvidenceError,
} from "./runtime/collaboration-runtime.js";
import { ProviderHealthStore } from "./runtime/provider-health-store.js";
import { RunGateUnitOfWork } from "./runtime/run-gate-unit-of-work.js";
import { executeReviewLaunchWithFence } from "./runtime/review-launch-admission.js";
import { ReviewEvidenceCapture } from "./runtime/review-evidence-capture.js";
import { matchesExactPrelaunchCliMissing } from "./runtime/prelaunch-evidence.js";
import { defaultAllowedProjectRoots, ProjectPolicy } from "./security/project-policy.js";
import { runCapabilityProbes, type CapabilityProbeRunner } from "./probes/capability-probe.js";
import { ensureStateLayout } from "./store/state-layout.js";
import { RunStore, type RunRecord } from "./store/run-store.js";
import { DurableWorker } from "./worker/durable-worker.js";
import { WorktreeLeaseStore, type WorktreeLease } from "./worktree/lease-store.js";
import type { AttemptAssignment } from "./workflow/workflow.js";
import { prepareCommandInput } from "./runners/provider-command.js";
import { discoverProviderVersion, normalizeProviderVersion } from "./probes/provider-version.js";
import { buildCapabilityProbeProviders } from "./probes/provider-probe-config.js";
import { auditSharedSkills, sharedSkillReadiness } from "./skills/audit.js";
import {
  parsePersistedDomainEffect,
  assertPersistedDomainEffectMatchesRun,
  isTransientSqliteError,
  type PersistedDomainEffect,
} from "./worker/domain-effect.js";

const stateRoot = process.env.AGENT_COLLAB_STATE_DIR ?? join(homedir(), ".local", "share", "agent-collab");
const layout = ensureStateLayout(stateRoot);
const grokBinary = process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok");
const claudeBinary = process.env.AGENT_COLLAB_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
const codexBinary = process.env.AGENT_COLLAB_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
const allowedProjectRoots = defaultAllowedProjectRoots();
const command = process.argv[2] ?? "status";
const REVIEW_PROVIDERS = REVIEW_PROVIDER_IDS;
const reviewSkillReadiness = (): Readonly<Record<ReviewProviderId, boolean>> => {
  try {
    return sharedSkillReadiness(auditSharedSkills({
      canonicalRoot: join(homedir(), ".agents", "skills"),
      agentRoots: {
        grok: join(homedir(), ".grok", "skills"),
        claude: join(homedir(), ".claude", "skills"),
        codex: join(homedir(), ".codex", "skills"),
      },
    }));
  } catch {
    return { grok: false, claude: false, codex: false };
  }
};
const reviewEvidenceCapture = new ReviewEvidenceCapture({
  captureSource: ({ project }) => ({
    sourceFingerprint: captureWorkspaceFingerprint(project).fingerprint, valid: true,
  }),
  captureReadiness: ({ agent }) => reviewSkillReadiness()[agent]
    ? { harnessReady: true, state: "ready", valid: true }
    : { harnessReady: false, state: "provider_unavailable", valid: false },
});
const capabilityProbeRunner: CapabilityProbeRunner = {
  execute: async (request) => {
    const version = spawnSync(request.file, ["--version"], { encoding: "utf8", timeout: 10_000, shell: false });
    if (version.status !== 0) throw version.error ?? new Error(version.stderr || "version probe failed");
    const prepared = prepareCommandInput(request);
    try {
      const processResult = await execa(request.file, prepared.args, {
        cwd: request.cwd,
        ...(prepared.input !== undefined ? { input: prepared.input } : {}),
        shell: false,
        reject: false,
        timeout: request.timeoutMs,
        cleanup: true,
        env: { AGENT_COLLAB_RUN: "1" },
      });
      return { exitCode: processResult.exitCode ?? -1, version: normalizeProviderVersion(version.stdout),
        stdout: processResult.stdout, stderr: processResult.stderr };
    } finally {
      prepared.cleanup();
    }
  },
};
const capabilityProbeProviders = (enabledAgent?: ReviewProviderId) => {
  return buildCapabilityProbeProviders({
    ...(enabledAgent === undefined ? {} : { enabledAgent }),
    binaries: { grok: grokBinary, claude: claudeBinary, codex: codexBinary },
    cwd: process.cwd(), discoverVersion: discoverProviderVersion,
  });
};

const isReviewProviderId = (value: unknown): value is ReviewProviderId =>
  typeof value === "string" && REVIEW_PROVIDERS.some((agent) => agent === value);

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

const assertCurrentAuthoritySchema = (database: string): void => {
  const db = new Database(database, { readonly: true });
  try { assertReviewV3SchemaSignature(db); } finally { db.close(); }
};

const markFreshHistoryV2 = (database: string): void => {
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
    if (stateVersion === 4 && historyVersion === 2) {
      assertCurrentAuthoritySchema(layout.database);
      return;
    }
    const migration = stateVersion === 3 && historyVersion === 2
      ? "migrate-v4"
      : stateVersion === 2 && historyVersion === 2 ? "migrate-v3" : "migrate-v2";
    throw new Error(`offline migration required: state=${stateVersion}, history=${historyVersion}; run ${migration} while the service is stopped`);
  }
  initializeCurrentExecutionSchema(layout.database);
  const service = new LocalCollabService(layout.database, { historyDatabase: layout.historyDatabase });
  service.close();
  markFreshHistoryV2(layout.historyDatabase);
  if (schemaVersion(layout.database) !== 4 || schemaVersion(layout.historyDatabase) !== 2) {
    throw new Error("fresh database initialization did not produce the required state=4, history=2 schema pair");
  }
  assertCurrentAuthoritySchema(layout.database);
};

if (command === "map-learn-close") {
  const taskPacketPath = resolve(process.argv[3] ?? "");
  const handoffPath = resolve(process.argv[4] ?? "");
  const candidatePath = resolve(process.argv[5] ?? "");
  if (!process.argv[3] || !process.argv[4] || !process.argv[5] || process.argv.length > 6) {
    throw new Error("Usage: agent-collab map-learn-close <task-packet> <handoff> <candidate>");
  }
  prepareDatabases();
  const service = new LocalCollabService(layout.database, { historyDatabase: layout.historyDatabase });
  try {
    console.log(JSON.stringify(service.closeMapLearning({
      taskPacketBytes: readFileSync(taskPacketPath),
      handoffBytes: readFileSync(handoffPath),
      candidateBytes: readFileSync(candidatePath),
    }), null, 2));
  } finally {
    service.close();
  }
  process.exit(0);
}

if (command === "map-evidence-record") {
  const findingPath = resolve(process.argv[3] ?? "");
  const purpose = process.argv[4];
  const evidenceId = process.argv[5];
  const artifactHash = process.argv[6];
  if (!process.argv[3] || !purpose || !evidenceId || !artifactHash || process.argv.length > 7 || ![
    "code_or_artifact_fix",
    "old_code_sensitive_regression",
    "sibling_surface_scan",
  ].includes(purpose)) {
    throw new Error("Usage: agent-collab map-evidence-record <finding-lifecycle.json> <code_or_artifact_fix|old_code_sensitive_regression|sibling_surface_scan> <evidence-id> <candidate-sha256>");
  }
  prepareDatabases();
  const service = new LocalCollabService(layout.database, { historyDatabase: layout.historyDatabase });
  try {
    const receipt = service.recordMapLearningEvidence({
      purpose: purpose as "code_or_artifact_fix" | "old_code_sensitive_regression" | "sibling_surface_scan",
      id: evidenceId,
      artifactHash,
      finding: JSON.parse(readFileSync(findingPath, "utf8")),
    });
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.result !== "PASS") process.exitCode = 1;
  } finally {
    service.close();
  }
  process.exit(process.exitCode ?? 0);
}

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

if (command === "migrate-v3") {
  assertServiceInactive();
  const result = new MigrationCoordinator({
    stateDatabase: layout.database,
    historyDatabase: layout.historyDatabase,
  }).migrateToV3();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "migrate-v4") {
  assertServiceInactive();
  const coordinator = new MigrationCoordinator({
    stateDatabase: layout.database,
    historyDatabase: layout.historyDatabase,
  });
  const stateVersion = schemaVersion(layout.database);
  const historyVersion = schemaVersion(layout.historyDatabase);
  if (stateVersion === 4 && historyVersion !== 2) {
    throw new Error(`v4 migration requires history=2; found state=${stateVersion}, history=${historyVersion}`);
  }
  const result = stateVersion === 4
    ? { status: "already_current" as const, fromVersion: 4, toVersion: 4 }
    : coordinator.migrateToV4();
  coordinator.extendReviewV3SchemaOffline();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (command === "extend-review-v3-schema") {
  assertServiceInactive();
  const stateVersion = schemaVersion(layout.database);
  const historyVersion = schemaVersion(layout.historyDatabase);
  if (stateVersion !== 4 || historyVersion !== 2) {
    throw new Error(`review-v3 schema extension requires state=4, history=2; found state=${stateVersion}, history=${historyVersion}`);
  }
  new MigrationCoordinator({
    stateDatabase: layout.database,
    historyDatabase: layout.historyDatabase,
  }).extendReviewV3SchemaOffline();
  console.log(JSON.stringify({ status: "extended", stateVersion: 4 }, null, 2));
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
  ...(run.artifactHash === undefined ? {} : { artifactHash: run.artifactHash }),
  idempotencyKey: run.idempotencyKey,
  ...(run.approvalScope === undefined ? {} : { approvalScope: run.approvalScope }),
  ...(run.payload === undefined ? {} : { payload: run.payload }),
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
      isReviewProviderId(agent)) {
    if (resolution === "completed") {
      store.close();
      throw new Error("review reconciliation cannot synthesize completed evidence; resolve as failed and replay a new lane");
    }
    effect = { type: "review", reviewId, attemptId: reviewAttemptId, role, agent,
      resultKind: "task_failure",
      ...(typeof run.payload?.providerAdmissionClaimedAt === "number"
        ? { providerAdmissionClaimedAt: run.payload.providerAdmissionClaimedAt }
        : {}) };
  } else if (workflowId && stageId && assignment && agent === "codex") {
    if (resolution === "completed") {
      store.close();
      throw new Error("workflow reconciliation cannot synthesize completed runner evidence; resolve as failed and start a fresh workflow identity");
    }
    const executionContext = asObject(asObject(run.launchInfo)?.executionContext);
    const lease = asObject(executionContext?.lease);
    effect = { type: "workflow_reconciliation_block", workflowId, stageId, runId: run.id,
      ...(lease ? { lease } : {}), terminalAt: Date.now() };
  } else {
    store.close(); throw new Error("reconciliation payload has no supported domain identity");
  }
  store.resolveReconciliation({ id: run.id,
    providerResult: { kind: "task_failure", ...(isReviewProviderId(agent) ? { agent } : {}),
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
  const reviews = new RunGateUnitOfWork(layout.database);
  const collaborationRuntime = new CollaborationRuntime(layout.database);
  const markStartupReconciliation = (at: number): void => {
    const store = new RunStore(layout.database);
    for (const run of store.needsReconciliation()) {
      const decision = asObject(run.payload?.decision);
      const agent = decision?.agent;
      const workflowId = typeof run.payload?.workflowId === "string" ? run.payload.workflowId : null;
      const workflowStageId = typeof run.payload?.workflowStageId === "string"
        ? run.payload.workflowStageId
        : null;
      if (workflowId && workflowStageId && agent === "codex") {
        collaborationRuntime.blockRunnerReconciliation(
          workflowId,
          workflowStageId,
          run.id,
          at,
        );
      }
    }
    store.close();
  };
  markStartupReconciliation(Date.now());
  const worktreeLeases = new WorktreeLeaseStore(layout.database);
  const startupOutbox = new RunStore(layout.database);
  collaborationRuntime.drainDispatchOutbox(startupOutbox); startupOutbox.close();

  const runner = new AgentRunner({ binaries: {
    grok: grokBinary,
    claude: claudeBinary,
    codex: codexBinary,
  },
    timeoutMs: 30 * 60_000, authorizationDatabasePath: layout.database });
  const effectStore = new RunStore(layout.database);
  const domainReplayOwner = `domain-replay:${process.pid}:${randomUUID()}`;
  class PersistedDomainEffectError extends Error {}
  function poison(message: string): never { throw new PersistedDomainEffectError(message); }
  const releaseRecordedLease = async (value: unknown): Promise<void> => {
    const lease = asObject(value) as unknown as WorktreeLease | null;
    if (!lease) return;
    await worktreeLeases.release({ worktreePath: lease.worktreePath, leaseId: lease.leaseId,
      fencingToken: lease.fencingToken, holder: lease.holder });
  };
  const applyDomainEffect = async (
    run: RunRecord,
    providerResult: Record<string, unknown>,
    effect: PersistedDomainEffect,
  ): Promise<void> => {
    const type = effect.type;
    const terminalAt = Number(effect.terminalAt);
    if (!Number.isSafeInteger(terminalAt) || terminalAt < 0) poison("invalid persisted domain-effect time");
    if (type === "workflow_reconciliation_block") {
      const workflowId = String(effect.workflowId);
      const stageId = String(effect.stageId);
      const runId = String(effect.runId);
      try {
        collaborationRuntime.blockRunnerReconciliation(workflowId, stageId, runId, terminalAt);
      } catch (error) {
        if (isTransientSqliteError(error)) throw error;
        poison(error instanceof Error ? error.message : String(error));
      }
      await releaseRecordedLease(effect.lease);
      return;
    }
    if (type === "workflow_dispatch_rejected") {
      const workflowId = String(effect.workflowId);
      const stageId = String(effect.stageId);
      const runId = String(effect.runId);
      const reason = String(effect.reason);
      try {
        collaborationRuntime.recordPrelaunchOutcome(workflowId, effect.prelaunchReceipt, terminalAt);
      } catch (error) {
        if (error instanceof RunnerOutcomeEvidenceError) poison(error.message);
        throw error;
      }
      await releaseRecordedLease(effect.lease);
      return;
    }
    if (type === "workflow") {
      const workflowId = String(effect.workflowId);
      const stageId = String(effect.stageId);
      const assignment = assignmentFrom(effect.assignment);
      const agent = effect.agent;
      const resultKind = String(effect.resultKind);
      if (!assignment || agent !== "codex") poison("invalid persisted workflow effect");
      const disposition = collaborationRuntime.dispatchDisposition(workflowId, stageId, assignment);
      if (disposition === "execute") {
        try {
          collaborationRuntime.recordRunnerOutcome(workflowId, effect.runnerReceipt, terminalAt);
        } catch (error) {
          if (error instanceof RunnerOutcomeEvidenceError) poison(error.message);
          throw error;
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
      if ((role !== "auditor" && role !== "critic") || !isReviewProviderId(agent)) {
        poison("invalid persisted review effect");
      }
      const attempt = reviews.attempts(reviewId, agent, role).find((item) => item.attemptId === attemptId);
      if (!attempt) poison("unknown persisted review attempt");
      if (resultKind === "success") {
        reviews.recordTerminal({ reviewId, agent, role, attemptId, status: "completed",
          result: providerResult, terminalAt });
      } else if (isFailoverOutcome(resultKind)) {
        reviews.recordProviderUnavailable({ reviewId, agent, role, attemptId,
          error: providerResult, terminalAt });
      } else {
        reviews.recordTerminal({ reviewId, agent, role, attemptId, status: "failed",
          error: providerResult, terminalAt });
      }
      const admissionClaimedAt = effect.providerAdmissionClaimedAt;
      if (resultKind === "success") {
        health.recordSuccess(agent, terminalAt, admissionClaimedAt);
        activateRecoveredReviewLanes({ agent, now: terminalAt, reviews, health,
          evidenceCapture: reviewEvidenceCapture });
      } else if (isFailoverOutcome(resultKind)) {
        const retryAt = typeof providerResult.retryAt === "number" ? providerResult.retryAt : undefined;
        health.recordFailoverFailure(agent, { kind: resultKind, ...(retryAt ? { retryAt } : {}) }, terminalAt, admissionClaimedAt);
      } else if (admissionClaimedAt !== undefined) {
        health.releaseAttempt(agent, terminalAt, admissionClaimedAt);
      }
      return;
    }
    poison("unknown persisted domain effect");
  };
  const replayClaimedDomainEffect = async (
    pending: RunRecord,
    providerResult: Record<string, unknown>,
    effectInput: unknown,
  ): Promise<void> => {
    try {
      let effect: PersistedDomainEffect;
      try {
        effect = parsePersistedDomainEffect(effectInput);
      } catch (error) {
        poison(error instanceof Error ? error.message : String(error));
      }
      try {
        assertPersistedDomainEffectMatchesRun(pending, providerResult, effect);
      } catch (error) {
        poison(error instanceof Error ? error.message : String(error));
      }
      await applyDomainEffect(pending, providerResult, effect);
      if (!effectStore.markDomainEffectApplied(pending.id, domainReplayOwner)) {
        const latest = effectStore.get(pending.id)?.result as { domainEffect?: unknown } | undefined;
        if (latest?.domainEffect !== "applied") {
          throw new Error(`domain effect lost its replay claim: ${pending.id}`);
        }
      }
    } catch (error) {
      if (error instanceof PersistedDomainEffectError) {
        effectStore.quarantineDomainEffect(pending.id, domainReplayOwner, error);
      } else {
        effectStore.releaseDomainEffectClaim(pending.id, domainReplayOwner, error);
      }
      throw error;
    }
  };
  const replayPendingDomainEffects = async (): Promise<void> => {
    const now = Date.now();
    for (const pending of effectStore.pendingDomainEffects(now)) {
      if (!effectStore.claimDomainEffect(pending.id, {
        owner: domainReplayOwner,
        now,
        leaseMs: 30_000,
      })) continue;
      try {
        const envelope = asObject(pending.result);
        const providerResult = asObject(envelope?.providerResult);
        const effect = envelope?.effect;
        if (!providerResult || effect === undefined) {
          poison(`invalid pending domain effect: ${pending.id}`);
        }
        await replayClaimedDomainEffect(pending, providerResult, effect);
      } catch (error) {
        if (error instanceof PersistedDomainEffectError) {
          effectStore.quarantineDomainEffect(pending.id, domainReplayOwner, error);
        } else {
          effectStore.releaseDomainEffectClaim(pending.id, domainReplayOwner, error);
        }
      }
    }
  };
  await replayPendingDomainEffects();
  const workers = Array.from({ length: 4 }, (_unused, index) => new DurableWorker({
    store: new RunStore(layout.database), workerId: `worker:${process.pid}:${index}`,
    runner: async (
      run,
      onLaunch,
      commitDomainEffect,
      persistExecutionContext,
      onLaunchIntent,
      onProvenNoSpawn,
    ) => {
      const reviewId = typeof run.payload?.reviewId === "string" ? run.payload.reviewId : null;
      const reviewAttemptId = typeof run.payload?.reviewAttemptId === "string" ? run.payload.reviewAttemptId : null;
      const role = run.payload?.reviewRole;
      const decision = asObject(run.payload?.decision);
      const agent = decision?.agent;
      if (reviewId && (role === "auditor" || role === "critic") && isReviewProviderId(agent)) {
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
          collaborationRuntime.recordProviderHealth(workflowId, "grok", available.grok, now);
          collaborationRuntime.recordProviderHealth(workflowId, "codex", available.codex, now);
          collaborationRuntime.retryBlockedStage(workflowId, now);
          const queue = new RunStore(layout.database);
          collaborationRuntime.drainDispatchOutbox(queue, now); queue.close();
        }
        const disposition = collaborationRuntime.dispatchDisposition(workflowId, workflowStageId, queuedAssignment);
        if (disposition !== "execute") {
          return disposition === "terminal"
            ? { kind: "task_failure", reconciledDispatch: disposition }
            : { kind: "success", reconciledDispatch: disposition };
        }
      }

      let lease: WorktreeLease | null = null;
      const project = typeof run.payload?.project === "string" ? run.payload.project : null;
      if (workflowId && project && agent === "codex") {
        const priorContext = asObject(asObject(run.launchInfo)?.executionContext);
        const priorLease = asObject(priorContext?.lease) as unknown as WorktreeLease | null;
        if (priorLease) {
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

      const launchDecision = await executeReviewLaunchWithFence({
        run,
        health,
        observedAt: Date.now(),
        evidenceCapture: reviewEvidenceCapture,
        reviews,
        reconcile: (reason) => effectStore.reconcileClaimedReviewIdentity(
          run.id, run.leaseToken!, reason),
        launch: () => runner.run(
          processTask(run),
          onLaunch,
          onLaunchIntent,
          onProvenNoSpawn,
        ),
      });
      const rawResult = asObject(launchDecision.providerResult) ?? {
        kind: "task_failure",
        error: "review launch fence returned no provider result",
      };
      if (rawResult.agent !== undefined && rawResult.agent !== agent) {
        throw new Error("runner result agent does not match the durable assignment");
      }
      let result = isReviewProviderId(agent)
        ? { ...rawResult, agent }
        : rawResult;
      if (
        reviewId &&
        (role === "auditor" || role === "critic") &&
        result.kind === "success"
      ) {
        try {
          result = normalizeReviewProviderResult(result);
        } catch (error) {
          result = {
            kind: "task_failure",
            agent,
            reviewOutputInvalid: true,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      let resultKind = typeof result.kind === "string" ? result.kind : "task_failure";
      const durableLaunch = effectStore.get(run.id);
      const durableLaunchInfo = asObject(durableLaunch?.launchInfo);
      if (durableLaunch?.launched && durableLaunchInfo?.phase !== "started") {
        return result;
      }
      let effect: Record<string, unknown> | null = null;
      if (workflowId && workflowStageId && queuedAssignment && agent === "codex") {
        const terminalAt = Date.now();
        const launched = effectStore.get(run.id)?.launched === true;
        if (!launched && isFailoverOutcome(resultKind) && !matchesExactPrelaunchCliMissing(
          effectStore.get(run.id)!,
          queuedAssignment as unknown as Readonly<Record<string, unknown>>,
          resultKind,
        )) {
          result = { kind: "task_failure", agent, rejectedPrelaunchOutcome: resultKind };
          resultKind = "task_failure";
        }
        const runnerReceipt = !launched ? null : {
          schemaVersion: "runner-outcome/v1",
          runId: run.id,
          runAttemptCount: run.attemptCount,
          dispatchId: run.idempotencyKey,
          workflowId,
          stageId: workflowStageId,
          attemptId: queuedAssignment.attemptId,
          attemptOrdinal: queuedAssignment.attemptOrdinal,
          agent: queuedAssignment.agent,
          model: queuedAssignment.model,
          policyVersion: queuedAssignment.policyVersion,
          sessionId: queuedAssignment.sessionId,
          resultKind,
        };
        const prelaunchReceipt = launched ? null : {
          schemaVersion: "prelaunch-outcome/v1",
          runId: run.id,
          runAttemptCount: run.attemptCount,
          dispatchId: run.idempotencyKey,
          workflowId,
          stageId: workflowStageId,
          attemptId: queuedAssignment.attemptId,
          attemptOrdinal: queuedAssignment.attemptOrdinal,
          agent: queuedAssignment.agent,
          model: queuedAssignment.model,
          policyVersion: queuedAssignment.policyVersion,
          sessionId: queuedAssignment.sessionId,
          resultKind,
        };
        effect = launched
          ? { type: "workflow", workflowId, stageId: workflowStageId,
              assignment: queuedAssignment, agent, resultKind, terminalAt,
              ...(runnerReceipt ? { runnerReceipt } : {}), ...(lease ? { lease } : {}) }
          : { type: "workflow_dispatch_rejected", workflowId, stageId: workflowStageId,
              runId: run.id, reason: resultKind, prelaunchReceipt, terminalAt,
              ...(lease ? { lease } : {}) };
      } else if (reviewId && reviewAttemptId && (role === "auditor" || role === "critic") &&
          isReviewProviderId(agent)) {
        effect = { type: "review", reviewId, attemptId: reviewAttemptId, role, agent,
          resultKind, terminalAt: Date.now(),
          ...(typeof run.payload?.providerAdmissionClaimedAt === "number"
            ? { providerAdmissionClaimedAt: run.payload.providerAdmissionClaimedAt }
            : {}) };
      }
      if (!effect) {
        return result;
      }
      commitDomainEffect({ providerResult: result, effect,
        status: resultKind === "success" || isFailoverOutcome(resultKind) ? "completed" : "failed" });
      const committed = effectStore.get(run.id)!;
      if (!effectStore.claimDomainEffect(run.id, {
        owner: domainReplayOwner,
        now: Date.now(),
        leaseMs: 30_000,
      })) throw new Error("committed domain effect could not be claimed");
      await replayClaimedDomainEffect(committed, result, effect);
      return result;
    }, leaseMs: 31 * 60_000,
  }));

  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  const workerLoops = workers.map(async (worker) => {
    while (!stopping) {
      const run = await worker.runOnce(Date.now());
      if (run === undefined) await delay(500);
    }
  });
  let lastRecovery = 0;
  while (!stopping) {
    const now = Date.now();
    if (now - lastRecovery >= 30_000) {
      const store = new RunStore(layout.database);
      store.recoverExpired(now); store.close();
      await replayPendingDomainEffects();
      markStartupReconciliation(now);
      await replayPendingDomainEffects();
      const outboxQueue = new RunStore(layout.database);
      collaborationRuntime.drainDispatchOutbox(outboxQueue, now); outboxQueue.close();
      const available = routingHealth(health, now);
      for (const recoverable of collaborationRuntime.workflows.recoverable()) {
        const recovery = recoverable.state.recovery;
        collaborationRuntime.recordProviderHealth(recoverable.workflowId, "grok", available.grok, now);
        collaborationRuntime.recordProviderHealth(recoverable.workflowId, "codex", available.codex, now);
        if (recovery?.nextRetryAt !== null && recovery?.nextRetryAt !== undefined && recovery.nextRetryAt <= now) {
          collaborationRuntime.retryBlockedStage(recoverable.workflowId, now);
        }
      }
      const recoveredQueue = new RunStore(layout.database);
      collaborationRuntime.drainDispatchOutbox(recoveredQueue, now); recoveredQueue.close();
      await runAutomaticProviderRecovery({ now, reviews, health,
        evidenceCapture: reviewEvidenceCapture,
        probe: async (agent) => {
          const probe = await runCapabilityProbes({
            providers: capabilityProbeProviders(agent), timeoutMs: 120_000,
            runner: capabilityProbeRunner,
          });
          const result = probe.results[agent];
          const failures = new Set(result.failures);
          const kind = failures.has("cli_missing") ? "cli_missing" as const
            : failures.has("probe_timeout") ? "network_timeout" as const
              : failures.has("authentication_failed") ? "auth" as const
                : "model_unavailable" as const;
          return result.ready ? { ready: true } : { ready: false, failure: { kind } };
        },
      });
      lastRecovery = now;
    }
    await delay(500);
  }
  await Promise.all(workerLoops);
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
    const probeAt = Date.now();
    const probeAdmissions = Object.fromEntries(REVIEW_PROVIDERS.map((agent) =>
      [agent, service.providers.acquireExplicitProbeAdmission(agent, probeAt)])) as
      Record<ReviewProviderId, ReturnType<ProviderHealthStore["acquireExplicitProbeAdmission"]>>;
    const providerConfig = capabilityProbeProviders();
    const result = await runCapabilityProbes({ providers: {
      grok: { ...providerConfig.grok, enabled: probeAdmissions.grok.runnable },
      claude: { ...providerConfig.claude, enabled: probeAdmissions.claude.runnable },
      codex: { ...providerConfig.codex, enabled: probeAdmissions.codex.runnable },
    }, timeoutMs: 120_000, runner: capabilityProbeRunner });
    for (const agent of REVIEW_PROVIDERS) {
      if (!probeAdmissions[agent].runnable) continue;
      const now = Date.now();
      const claimedAt = probeAdmissions[agent].claimedAt;
      if (result.results[agent].ready) service.providers.recordSuccess(agent, now, claimedAt);
      else service.providers.recordFailoverFailure(agent, { kind: "model_unavailable" }, now, claimedAt);
    }
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "doctor") {
    const binaries = Object.fromEntries(([
      { agent: "grok", path: grokBinary },
      { agent: "claude", path: claudeBinary },
      { agent: "codex", path: codexBinary },
    ]).map(({ agent, path }) => {
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
