#!/usr/bin/env node
import { accessSync, chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { execa } from "execa";
import { createReviewRuntimeComposition } from "./app/review-runtime-composition.js";
import { inspectReviewReadiness } from "./app/review-readiness-service.js";
import { ReviewStatusQuery } from "./app/review-status-query.js";
import { createReviewWorkerRuntime } from "./app/review-worker-runtime.js";
import { ReviewWorkerService } from "./app/review-worker-service.js";
import { createStg04CloseService } from "./app/stg04-close-service.js";
import {
  REVIEW_PROVIDER_IDS,
  type ReviewProviderId,
} from "./domain/routing.js";
import { MapControlPlane } from "./flow/map-admin.js";
import { HistoryIndex } from "./history/index.js";
import { HistoryVisibilityPolicy } from "./history/visibility-policy.js";
import { doctorV1, doctorV1Databases, initializeCurrentExecutionSchemaDatabase, MigrationCoordinator, prepareRollbackBundle, restoreV1Bundle, verifyBundle, verifyCompatibilityRuntime } from "./migration/coordinator.js";
import {
  adoptProductionReviewedV4Source,
  createProductionReviewedV4MigrationProcess,
  resolveReviewedV4ProductionSourceRoot,
} from "./migration/reviewed-v4-production-process.js";
import { buildReviewedV4Promotion } from "./migration/reviewed-v4-promotion-builder.js";
import { openStateDatabaseLease, type StateDatabaseAdmissionMode, type StateDatabaseLease } from "./store/state-database-fence.js";
import { assertReviewV3SchemaSignature } from "./migration/review-v3-schema.js";
import { AgentRunner } from "./runners/agent-runner.js";
import { captureWorkspaceFingerprint } from "./runtime/workspace-fingerprint.js";
import {
  activateReviewedWorkerService,
  stageReviewedWorkerService,
} from "./runtime/review-service-unit.js";
import { runUserSystemctl } from "./runtime/systemd-user.js";
import { ProviderHealthStore } from "./runtime/provider-health-store.js";
import { ReviewEvidenceCapture } from "./runtime/review-evidence-capture.js";
import { runCapabilityProbes, type CapabilityProbeRunner } from "./probes/capability-probe.js";
import { acquireStateRootLease, ensureStateLayout, openExistingStateLayout } from "./store/state-layout.js";
import { RunStore } from "./store/run-store.js";
import { prepareCommandInput } from "./runners/provider-command.js";
import { discoverProviderVersion, normalizeProviderVersion } from "./probes/provider-version.js";
import { buildCapabilityProbeProviders } from "./probes/provider-probe-config.js";
import { auditSharedSkills, sharedSkillReadiness } from "./skills/audit.js";
import { linkReviewHarnessSkills, type ReviewHarnessId } from "./skills/setup.js";
import { startStdioReviewOnlyMcpServer } from "./mcp/review-only-server.js";
import { startStdioReviewStatusOnlyMcpServer } from "./mcp/review-status-only-server.js";
const command = process.argv[2] ?? "status";
const PERMANENTLY_QUARANTINED_COMMANDS = new Set([
  "worker",
  "mcp",
  "review-mcp",
  "mcp-verify-session",
  "start-normal",
  "prove-normal",
  "verify-unit",
  "compatibility-runtime",
  "migrate-v4",
  "extend-review-v3-schema",
]);
if (PERMANENTLY_QUARANTINED_COMMANDS.has(command)) {
  throw new Error(`legacy runtime command ${command} is permanently quarantined`);
}
type CliStateAdmissionMode = StateDatabaseAdmissionMode | "exclusive_migration" | "no_state";
const CLI_STATE_ADMISSION = {
  "review-readiness": "no_state",
  "review-skills-link": "no_state",
  "reviewed-source-promote": "no_state",
  "review-service-stage": "no_state",
  "compatibility-status": "offline_observation",
  "doctor-v1": "offline_observation",
  "verify-bundle": "offline_observation",
  "restore-v1": "exclusive_migration",
  "migrate-v2": "exclusive_migration",
  "migrate-v3": "exclusive_migration",
  "reviewed-source-adopt": "exclusive_migration",
  "stg04-close-preflight": "offline_observation",
  "stg04-close-status": "offline_observation",
  "stg04-close-prepare": "exclusive_migration",
  "review-service-activate": "offline_observation",
  "review-mcp-status": "offline_observation",
  "review-initialize": "mutating_service",
  "review-mcp-codex": "mutating_service",
  "review-worker": "mutating_service",
  "map-learn-close": "mutating_service",
  "map-evidence-record": "mutating_service",
  "reconcile-run": "mutating_service",
  probe: "mutating_service",
  status: "offline_observation",
  doctor: "no_state",
} as const satisfies Record<string, CliStateAdmissionMode>;
const commandAdmission = CLI_STATE_ADMISSION[command as keyof typeof CLI_STATE_ADMISSION];
if (!commandAdmission) throw new Error(`unknown command: ${command}`);
if (command === "verify-bundle") {
  console.log(JSON.stringify(verifyBundle(resolve(process.argv[3] ?? "")), null, 2));
  process.exit(0);
}
const grokBinary = process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok");
const claudeBinary = process.env.AGENT_COLLAB_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
const codexBinary = process.env.AGENT_COLLAB_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
const canonicalSkillRoot = join(homedir(), ".agents", "skills");
const agentSkillRoots = {
  grok: join(homedir(), ".grok", "skills"),
  claude: join(homedir(), ".claude", "skills"),
  codex: join(homedir(), ".codex", "skills"),
} as const;
const reviewBinaries = { grok: grokBinary, claude: claudeBinary, codex: codexBinary } as const;
const inspectReadiness = () => inspectReviewReadiness({
  canonicalSkillRoot,
  agentSkillRoots,
  binaries: reviewBinaries,
});
const waitForStdioShutdown = (): Promise<void> => new Promise((resolveShutdown) => {
  let resolved = false;
  const finish = () => {
    if (resolved) return;
    resolved = true;
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    process.stdin.off("end", finish);
    process.stdin.off("close", finish);
    resolveShutdown();
  };
  process.once("SIGINT", finish);
  process.once("SIGTERM", finish);
  process.stdin.once("end", finish);
  process.stdin.once("close", finish);
});
const writeOperationalEvent = (event: string, details: Record<string, unknown> = {}): void => {
  process.stderr.write(`${JSON.stringify({
    protocol: "agent-collab-operational-event/v1",
    event,
    recordedAt: Date.now(),
    ...details,
  })}\n`);
};
if (command === "review-readiness" || command === "doctor") {
  if (process.argv.length !== 3) throw new Error(`Usage: agent-collab ${command}`);
  const readiness = inspectReadiness();
  console.log(JSON.stringify(readiness, null, 2));
  if (!readiness.readyForCodexOnly) process.exitCode = 1;
  process.exit(process.exitCode ?? 0);
}
if (command === "review-skills-link") {
  const requested = process.argv.slice(3);
  const agents = (requested.length === 0 ? ["codex", "grok", "claude"] : requested) as ReviewHarnessId[];
  if (agents.some((agent) => !["grok", "claude", "codex"].includes(agent))) {
    throw new Error("Usage: agent-collab review-skills-link [codex] [grok] [claude]");
  }
  console.log(JSON.stringify(linkReviewHarnessSkills({
    canonicalRoot: canonicalSkillRoot,
    agentRoots: agentSkillRoots,
    agents,
  }), null, 2));
  process.exit(0);
}
if (command === "reviewed-source-promote") {
  const [auditorReceiptPath, criticReceiptPath, outputPath, expiresAt, promotionId] = process.argv.slice(3);
  const privateKeyPath = process.env.AGENT_COLLAB_REVIEWED_SOURCE_PRIVATE_KEY_FILE;
  const remoteUrl = process.env.AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_URL;
  const remoteRef = process.env.AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_REF;
  if (!auditorReceiptPath || !criticReceiptPath || !outputPath || !expiresAt || !promotionId ||
      process.argv.length !== 8 || !privateKeyPath || !remoteUrl || !remoteRef) {
    throw new Error("Usage: agent-collab reviewed-source-promote <auditor-receipt.json> <critic-receipt.json> <output.json> <expires-at> <promotion-id>; configure private-key file and remote trust env");
  }
  console.log(JSON.stringify(buildReviewedV4Promotion({
    repositoryRoot: resolveReviewedV4ProductionSourceRoot(),
    remote: { url: remoteUrl, ref: remoteRef },
    privateKeyPath,
    auditorReceiptPath,
    criticReceiptPath,
    outputPath,
    expiresAt,
    promotionId,
  }), null, 2));
  process.exit(0);
}
if (command === "review-service-stage") {
  const backupDirectory = process.argv[3];
  if (!backupDirectory || !isAbsolute(backupDirectory) || process.argv.length !== 4) {
    throw new Error("Usage: agent-collab review-service-stage </absolute/nonexistent/backup-directory>");
  }
  console.log(JSON.stringify(stageReviewedWorkerService({
    repositoryRoot: resolveReviewedV4ProductionSourceRoot(),
    homeDirectory: homedir(),
    backupDirectory: resolve(backupDirectory),
  }), null, 2));
  process.exit(0);
}
if (command === "review-worker" || command === "review-mcp-codex" || command === "review-initialize") {
  const readiness = inspectReadiness();
  if (!readiness.readyForCodexOnly) {
    throw new Error("Codex review harness is not ready; run review-skills-link and review-readiness before starting runtime services");
  }
}
const stateRoot = process.env.AGENT_COLLAB_STATE_DIR ?? join(homedir(), ".local", "share", "agent-collab");
const compatibilityOnly = command === "compatibility-status";
const existingStateOnly = compatibilityOnly || command === "doctor-v1" || command === "restore-v1" ||
  command === "reviewed-source-adopt" || command === "stg04-close-preflight" ||
  command === "stg04-close-status" || command === "stg04-close-prepare" ||
  command === "review-service-activate" ||
  command === "review-mcp-status" || command === "status";
const layout = existingStateOnly ? openExistingStateLayout(stateRoot) : ensureStateLayout(stateRoot);

if (compatibilityOnly) {
  const lease = openStateDatabaseLease(layout.database,
    commandAdmission as StateDatabaseAdmissionMode, { readonly: true });
  const compatibility = verifyCompatibilityRuntime({ stateDatabase: layout.database, historyDatabase: layout.historyDatabase });
  lease.close();
  console.log(JSON.stringify(compatibility, null, 2));
  process.exit(0);
}
if (command === "status" || command === "review-mcp-status") {
  const lease = openStateDatabaseLease(layout.database, "offline_observation", { readonly: true });
  const status = new ReviewStatusQuery(lease);
  if (command === "status") {
    try { console.log(JSON.stringify(await status.status(), null, 2)); }
    finally { status.close(); }
    process.exit(0);
  }
  const server = await startStdioReviewStatusOnlyMcpServer(status);
  try { await waitForStdioShutdown(); }
  finally { await server.close(); }
  process.exit(0);
}
const REVIEW_PROVIDERS = REVIEW_PROVIDER_IDS;
const reviewSkillReadiness = (): Readonly<Record<ReviewProviderId, boolean>> => {
  try {
    return sharedSkillReadiness(auditSharedSkills({
      canonicalRoot: canonicalSkillRoot,
      agentRoots: agentSkillRoots,
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
    const version = await execa(request.file, ["--version"], {
      encoding: "utf8", timeout: 10_000, shell: false, reject: false,
      ...(request.signal ? { cancelSignal: request.signal } : {}),
      forceKillAfterDelay: 2_000,
    });
    if (version.exitCode !== 0) throw new Error(version.stderr || "version probe failed");
    const prepared = prepareCommandInput(request);
    try {
      const processResult = await execa(request.file, prepared.args, {
        cwd: request.cwd,
        ...(prepared.input !== undefined ? { input: prepared.input } : {}),
        shell: false,
        reject: false,
        timeout: request.timeoutMs,
        cleanup: true,
        ...(request.signal ? { cancelSignal: request.signal } : {}),
        forceKillAfterDelay: 2_000,
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

const historyTableExists = (database: string, table: string): boolean => {
  const db = new Database(database, { readonly: true });
  try { return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined; }
  finally { db.close(); }
};

const historySchemaVersion = (database: string): number => {
  const db = new Database(database, { readonly: true });
  try { return Number(db.pragma("user_version", { simple: true })); }
  finally { db.close(); }
};

const assertCurrentAuthoritySchema = (db: Database.Database): void => assertReviewV3SchemaSignature(db);

const markFreshHistoryV2 = (database: string): void => {
  const db = new Database(database);
  try { db.pragma("user_version = 2"); } finally { db.close(); }
};

const prepareDatabases = (mode: StateDatabaseAdmissionMode = "mutating_service"): StateDatabaseLease => {
  const lease = openStateDatabaseLease(layout.database, mode);
  const state = lease.database;
  try {
  const hasState = state.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get("runtime_provider_health") !== undefined;
  const hasHistory = historyTableExists(layout.historyDatabase, "sources");
  if (hasState !== hasHistory) throw new Error("state/history schema pair is incomplete; refusing automatic repair");
  if (hasState) {
    const stateVersion = Number(state.pragma("user_version", { simple: true }));
    const historyVersion = historySchemaVersion(layout.historyDatabase);
    if (stateVersion === 2 && historyVersion === 2) {
      throw new Error("offline migration required: state=2, history=2; run migrate-v3 while the service is stopped");
    }
    if (!((stateVersion === 3 || stateVersion === 4) && historyVersion === 2)) {
      throw new Error(`offline migration required: state=${stateVersion}, history=${historyVersion}; run migrate-v2 while the service is stopped`);
    }
    const compatibility = verifyCompatibilityRuntime({
      stateDatabase: layout.database,
      historyDatabase: layout.historyDatabase,
    });
    if (compatibility.stateVersion === 4) {
      assertCurrentAuthoritySchema(state);
      return lease;
    }
    throw new Error(`offline migration required: state=${compatibility.stateVersion}, history=${compatibility.historyVersion}; run migrate-v4 while the service is stopped`);
  }
  initializeCurrentExecutionSchemaDatabase(state);
  const map = new MapControlPlane(lease.borrow());
  map.close();
  const history = new HistoryIndex(layout.historyDatabase, { visibilityPolicy: new HistoryVisibilityPolicy() });
  history.close();
  chmodSync(layout.historyDatabase, 0o600);
  markFreshHistoryV2(layout.historyDatabase);
  if (Number(state.pragma("user_version", { simple: true })) !== 4 || historySchemaVersion(layout.historyDatabase) !== 2) {
    throw new Error("fresh database initialization did not produce the required state=4, history=2 schema pair");
  }
  assertCurrentAuthoritySchema(state);
  return lease;
  } catch (error) {
    lease.close();
    throw error;
  }
};

if (command === "map-learn-close") {
  const taskPacketPath = resolve(process.argv[3] ?? "");
  const handoffPath = resolve(process.argv[4] ?? "");
  const candidatePath = resolve(process.argv[5] ?? "");
  if (!process.argv[3] || !process.argv[4] || !process.argv[5] || process.argv.length > 6) {
    throw new Error("Usage: agent-collab map-learn-close <task-packet> <handoff> <candidate>");
  }
  const lease = prepareDatabases();
  const map = new MapControlPlane(lease);
  try {
    console.log(JSON.stringify(map.closeLearning({
      taskPacketBytes: readFileSync(taskPacketPath),
      handoffBytes: readFileSync(handoffPath),
      candidateBytes: readFileSync(candidatePath),
    }), null, 2));
  } finally {
    map.close();
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
  const lease = prepareDatabases();
  const map = new MapControlPlane(lease);
  try {
    const receipt = map.recordLearningEvidence({
      purpose: purpose as "code_or_artifact_fix" | "old_code_sensitive_regression" | "sibling_surface_scan",
      id: evidenceId,
      artifactHash,
      finding: JSON.parse(readFileSync(findingPath, "utf8")),
    });
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.result !== "PASS") process.exitCode = 1;
  } finally {
    map.close();
  }
  process.exit(process.exitCode ?? 0);
}

const assertServiceInactive = (): void => {
  for (const unit of ["agent-collab.service", "agent-collab-reviewed.service"]) {
    const state = runUserSystemctl(["is-active", unit]);
    const observed = state.stdout.trim();
    if ((state.status !== 3 && state.status !== 4) ||
        (observed !== "inactive" && observed !== "unknown")) {
      throw new Error(`${unit} must be confirmed inactive; status=${String(state.status)} state=${observed || "empty"}`);
    }
  }
};

const exactSha256Argument = (name: string): string => {
  const value = process.argv[3];
  if (!value || !/^[a-f0-9]{64}$/.test(value) || process.argv.length !== 4) {
    throw new Error(`Usage: agent-collab ${name} <source-adoption-sha256>`);
  }
  return value;
};

if (command === "reviewed-source-adopt") {
  if (!process.argv[3] || !isAbsolute(process.argv[3]) || process.argv.length !== 4) {
    throw new Error("Usage: agent-collab reviewed-source-adopt </absolute/path/reviewed-v4-promotion.json>");
  }
  assertServiceInactive();
  console.log(JSON.stringify(adoptProductionReviewedV4Source({
    stateRoot: layout.root,
    externalPromotionPath: resolve(process.argv[3]),
  }), null, 2));
  process.exit(0);
}

if (command === "stg04-close-preflight" || command === "stg04-close-status" ||
    command === "review-service-activate") {
  const sourceAcceptanceReceiptSha256 = exactSha256Argument(command);
  if (command === "stg04-close-preflight" || command === "review-service-activate") assertServiceInactive();
  const stateAccess = openStateDatabaseLease(layout.database, "offline_observation", { readonly: true });
  const migration = createProductionReviewedV4MigrationProcess({
    stateRoot: layout.root,
    sourceAcceptanceReceiptSha256,
  });
  try {
    const close = createStg04CloseService({
      stateRoot: layout.root,
      repositoryRoot: resolveReviewedV4ProductionSourceRoot(),
      migration,
      openStateDatabaseAccess: () => stateAccess.borrow(),
    });
    try {
      const state = close.status();
      const readiness = command === "stg04-close-preflight" ? inspectReadiness() : undefined;
      if (state.contradictionCodes.length > 0 ||
          (readiness !== undefined && !readiness.readyForCodexOnly)) {
        process.exitCode = 1;
      }
      if (command === "review-service-activate") {
        if (state.phase !== "PROJECTION_CURRENT" || state.contradictionCodes.length > 0) {
          throw new Error("review service activation requires exact STG-04 PROJECTION_CURRENT state");
        }
      } else {
        console.log(JSON.stringify({
          protocol: command === "stg04-close-preflight"
            ? "agent-collab-stg04-close-preflight/v1"
            : "agent-collab-stg04-close-status/v1",
          ready: state.contradictionCodes.length === 0,
          state,
          ...(readiness ? { readiness } : {}),
        }, null, 2));
      }
    } finally { close.close(); }
  } finally {
    migration.close();
    stateAccess.close();
  }
  if (command === "review-service-activate") {
    console.log(JSON.stringify(activateReviewedWorkerService({
      repositoryRoot: resolveReviewedV4ProductionSourceRoot(),
      homeDirectory: homedir(),
    }), null, 2));
  }
  process.exit(process.exitCode ?? 0);
}

if (command === "doctor-v1") {
  console.log(JSON.stringify(doctorV1({ stateDatabase: layout.database, historyDatabase: layout.historyDatabase }), null, 2));
  process.exit(0);
}

if (command === "restore-v1") {
  assertServiceInactive();
  const rootLease = acquireStateRootLease(layout.root, "exclusive");
  let restored: ReturnType<typeof restoreV1Bundle>;
  let doctor: ReturnType<typeof doctorV1Databases>;
  try {
    rootLease.assertCurrent();
    const stateDatabase = join(rootLease.pinnedRoot, basename(layout.database));
    const historyDatabase = join(rootLease.pinnedRoot, basename(layout.historyDatabase));
    restored = restoreV1Bundle({ bundleDirectory: resolve(process.argv[3] ?? ""),
      stateDatabase, historyDatabase });
    const state = new Database(stateDatabase, { readonly: true });
    const history = new Database(historyDatabase, { readonly: true });
    try { doctor = doctorV1Databases(state, history); }
    finally { state.close(); history.close(); }
    rootLease.assertCurrent();
  } finally {
    rootLease.release();
  }
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

if (command === "stg04-close-prepare") {
  const sourceAcceptanceReceiptSha256 = exactSha256Argument(command);
  assertServiceInactive();
  const migration = createProductionReviewedV4MigrationProcess({
    stateRoot: layout.root,
    sourceAcceptanceReceiptSha256,
  });
  const close = createStg04CloseService({
    stateRoot: layout.root,
    repositoryRoot: resolveReviewedV4ProductionSourceRoot(),
    migration,
    openStateDatabaseAccess: () => openStateDatabaseLease(layout.database, "mutating_service"),
  });
  try {
    const result = await close.prepare({
      acceptedAt: Date.parse("2026-09-04T17:10:00+08:00"),
      publishedAt: Date.now(),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    close.close();
    migration.close();
  }
  process.exit(0);
}

if (commandAdmission === "exclusive_migration" || commandAdmission === "offline_observation" ||
    commandAdmission === "no_state") {
  throw new Error(`command ${command} did not terminate in its exclusive/offline branch`);
}
const runtimeAdmissionMode: StateDatabaseAdmissionMode = commandAdmission;
const runtimeLease = prepareDatabases(runtimeAdmissionMode);

if (command === "review-initialize") {
  console.log(JSON.stringify({
    protocol: "agent-collab-review-initialize/v1",
    stateVersion: Number(runtimeLease.database.pragma("user_version", { simple: true })),
    historyVersion: historySchemaVersion(layout.historyDatabase),
  }, null, 2));
  runtimeLease.close();
  process.exit(0);
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

if (command === "reconcile-run") {
  const runId = process.argv[3] ?? "";
  const resolution = process.argv[4];
  if (resolution !== "completed" && resolution !== "failed") {
    throw new Error("reconcile-run requires <run-id> <completed|failed>");
  }
  const store = new RunStore(runtimeLease.borrow(), { scope: "review" });
  const run = store.get(runId);
  if (!run || run.status !== "needs_reconciliation") throw new Error("run is not awaiting reconciliation");
  const decision = asObject(run.payload?.decision);
  const agent = decision?.agent;
  const reviewId = typeof run.payload?.reviewId === "string" ? run.payload.reviewId : null;
  const reviewAttemptId = typeof run.payload?.reviewAttemptId === "string" ? run.payload.reviewAttemptId : null;
  const role = run.payload?.reviewRole;
  if (!reviewId || !reviewAttemptId || (role !== "auditor" && role !== "critic") ||
      !isReviewProviderId(agent)) {
    store.close(); throw new Error("reconciliation payload has no supported domain identity");
  }
  if (resolution === "completed") {
    store.close();
    throw new Error("review reconciliation cannot synthesize completed evidence; resolve as failed and replay a new lane");
  }
  const effect = { type: "review", reviewId, attemptId: reviewAttemptId, role, agent,
    resultKind: "task_failure",
    ...(typeof run.payload?.providerAdmissionClaimedAt === "number"
      ? { providerAdmissionClaimedAt: run.payload.providerAdmissionClaimedAt }
      : {}) };
  store.resolveReconciliation({ id: run.id,
    providerResult: { kind: "task_failure", ...(isReviewProviderId(agent) ? { agent } : {}),
      reconciledByOperator: true, reconciledAt: Date.now() },
    effect: { terminalAt: Date.now(), ...effect }, status: resolution });
  console.log(JSON.stringify({ runId, resolution, domainEffect: "pending_worker_replay" }, null, 2));
  store.close(); runtimeLease.close(); process.exit(0);
}

if (command === "review-mcp-codex") {
  const service = createReviewRuntimeComposition(runtimeLease);
  const server = await startStdioReviewOnlyMcpServer(service);
  try { await waitForStdioShutdown(); }
  finally { await server.close(); }
} else if (command === "review-worker") {
  const runner = new AgentRunner({
    binaries: { grok: grokBinary, claude: claudeBinary, codex: codexBinary },
    timeoutMs: 30 * 60_000,
    authorizationDatabasePath: layout.database,
  });
  const probe = async (agent: ReviewProviderId, signal?: AbortSignal) => {
    const result = (await runCapabilityProbes({
      providers: capabilityProbeProviders(agent),
      timeoutMs: 120_000,
      runner: capabilityProbeRunner,
      ...(signal ? { signal } : {}),
    })).results[agent];
    const failures = new Set(result.failures);
    const kind = failures.has("cli_missing") ? "cli_missing" as const
      : failures.has("probe_timeout") ? "network_timeout" as const
        : failures.has("authentication_failed") ? "auth" as const
          : "model_unavailable" as const;
    return result.ready ? { ready: true as const } : { ready: false as const, failure: { kind } };
  };
  const runtime = (workerId: string) => createReviewWorkerRuntime({
    stateDatabase: runtimeLease,
    workerId,
    runner,
    evidenceCapture: reviewEvidenceCapture,
    probe,
  });
  const workers = Array.from({ length: 4 }, (_unused, index) =>
    runtime(`review-worker:${process.pid}:${index}`));
  const service = new ReviewWorkerService({
    workers,
    control: runtime(`review-control:${process.pid}`),
    onRecovery({ expired, replay, providers }) {
      const replayCount = replay.applied + replay.deferred + replay.quarantined;
      const transitions = providers.filter((result) => result.status !== "not_due");
      if (expired > 0 || replayCount > 0 || transitions.length > 0) {
        writeOperationalEvent("review_recovery_observed", {
          expired,
          replay,
          providers: transitions.map((result) => ({
            agent: result.agent,
            status: result.status,
            generation: result.generation,
            ...(result.rejoin ? { rejoin: result.rejoin } : {}),
          })),
        });
      }
    },
  });
  const stop = () => service.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const readiness = inspectReadiness();
  writeOperationalEvent("review_worker_started", {
    processId: process.pid,
    workerCount: workers.length,
    degradedOptionalProviders: readiness.degradedOptionalProviders,
  });
  try {
    await service.run();
  } catch (error) {
    writeOperationalEvent("review_worker_failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  } finally {
    runtimeLease.close();
    writeOperationalEvent("review_worker_stopped", { processId: process.pid });
  }
} else if (command === "probe") {
  if (process.argv[3] !== "APPROVE_LIVE_CAPABILITY_PROBE") {
    throw new Error("live capability probing may incur provider cost; pass APPROVE_LIVE_CAPABILITY_PROBE explicitly");
  }
  const health = new ProviderHealthStore(runtimeLease.borrow(), { cooldownMs: 60_000 });
  try {
    const probeAt = Date.now();
    const probeAdmissions = Object.fromEntries(REVIEW_PROVIDERS.map((agent) => [
      agent,
      health.acquireExplicitProbeAdmission(agent, probeAt),
    ])) as Record<ReviewProviderId, ReturnType<ProviderHealthStore["acquireExplicitProbeAdmission"]>>;
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
      if (result.results[agent].ready) health.recordSuccess(agent, now, claimedAt);
      else health.recordFailoverFailure(agent, { kind: "model_unavailable" }, now, claimedAt);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    health.close();
    runtimeLease.close();
  }
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
  runtimeLease.close();
} else {
  runtimeLease.close();
  throw new Error(`unknown command: ${command}`);
}
