import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperationalRestore,
  StateV4RestoreGuard,
  type OperationalHost,
  type OperationalPermitAction,
  type OperationalTarget,
  type OperationalVerification,
} from "../src/migration/operational-restore.js";
import { assertPhysicalRestoreAllowed } from "../src/migration/state-v4-restore-authority.js";

const roots: string[] = [];
const managedServicePids = new Set<number>();
const digest = (value: string) => value.repeat(64).slice(0, 64);
const dispatcher = {
  path: "/opt/agent-collab/dispatcher.js",
  sha256: digest("d"),
  mcpRegistration: "node /opt/agent-collab/dispatcher.js mcp",
};

const v1Target: OperationalTarget = {
  version: "v1",
  stateDatabase: { path: "/rollback/collaboration-v1.db", sha256: digest("1") },
  historyDatabase: { path: "/rollback/history-v1.db", sha256: digest("2") },
  runtime: { path: "/opt/agent-collab/v1", sha256: digest("3") },
  unit: { path: "/rollback/agent-collab-v1.service", sha256: digest("4") },
  dispatcher,
  bundle: { path: "/rollback/v1", sha256: digest("5") },
  serviceWasActive: true,
  poisonProviders: ["claude", "codex", "grok"],
};

const v2Target: OperationalTarget = {
  version: "v2",
  stateDatabase: { path: "/active/collaboration.db", sha256: digest("a") },
  historyDatabase: { path: "/active/history.db", sha256: digest("b") },
  runtime: { path: "/opt/agent-collab/v2", sha256: digest("c") },
  unit: { path: "/active/agent-collab.service", sha256: digest("e") },
  dispatcher,
  bundle: { path: "/active/v2-snapshot", sha256: digest("f") },
  serviceWasActive: true,
  poisonProviders: ["claude", "codex", "grok"],
};

interface PhysicalState {
  stateDatabase: string;
  historyDatabase: string;
  runtimeSymlink: string;
  unitDigest: string;
  dispatcherDigest: string;
  service: { active: boolean; pid?: number; execStart: string };
  verificationService?: { active: boolean; pid: number; execStart: string };
  openDatabaseFds: number;
}

interface DurablePairBackupEvidence {
  version: "v1" | "v2";
  stateDatabase: { path: string; sha256: string };
  historyDatabase: { path: string; sha256: string };
  wal: { checkpointed: true; sourceWalObserved: boolean; sourceShmObserved: boolean };
}

type FaultAction =
  | "dispatcher_config:v1" | "terminate_legacy:v2" | "systemd_inactive:v2"
  | "scan_processes:v2:pid,db,wal,shm"
  | "stop:v2" | "drain:v2" | "fds_zero:v2" | "verify_target:v1" | "verify_target:v2"
  | "backup_pair:v2" | "stage:v1" | "db_pair:begin:v1" | "restore_state:v1"
  | "restore_history:v1" | "db_pair:commit:v1" | "runtime:v1" | "unit:v1"
  | "mcp:v1" | "start_verification:v1" | "start:v1" | "is_active:v1" | "pid:v1" | "exec_start:v1"
  | "mcp_initialize:v1" | "mcp_list_tools:v1"
  | "daemon_reload" | "verify_physical:v1" | "poison:end:v1" | "verify_lock:release"
  | "lock:exclusive" | "cleanup:v1" | "commit:v1" | "verify_normal:v1" | "handoff_restart:v1"
  | "stop:v1" | "drain:v1" | "fds_zero:v1" | "backup_pair:v1" | "stage:v2"
  | "db_pair:begin:v2" | "restore_state:v2" | "restore_history:v2" | "db_pair:commit:v2"
  | "runtime:v2" | "unit:v2" | "mcp:v2" | "start_verification:v2" | "start:v2"
  | "is_active:v2" | "pid:v2" | "exec_start:v2" | "mcp_initialize:v2" | "mcp_list_tools:v2"
  | "verify_physical:v2" | "stop_verification:v2" | "drain_verification:v2" | "poison:end:v2"
  | "cleanup:v2" | "commit:v2" | "verify_normal:v2"
  | "maintenance:off" | "lock:release";

class SimulatedCrash extends Error {
  constructor(action: string) { super(`simulated process crash before ${action}`); }
}

class FakeHost implements OperationalHost {
  readonly actions: string[] = [];
  readonly phaseBeforeAction: Array<{ action: string; phase: string }> = [];
  readonly permits = new Map<string, { action: OperationalPermitAction; nonce: string; used: boolean }>();
  readonly mcp = {
    codex: "codex-before\nagent-collab=direct-v2\ncodex-after\n",
    grok: "grok-before\nagent-collab=direct-v2\ngrok-after\n",
  };
  physical: PhysicalState = {
    stateDatabase: v2Target.stateDatabase.sha256,
    historyDatabase: v2Target.historyDatabase.sha256,
    runtimeSymlink: v2Target.runtime.path,
    unitDigest: v2Target.unit.sha256,
    dispatcherDigest: dispatcher.sha256,
    service: { active: true, pid: 2002, execStart: `${dispatcher.path} worker` },
    openDatabaseFds: 2,
  };
  maintenance = false;
  dispatcherLock: "shared" | "exclusive" | undefined;
  verificationLock = false;
  poisonCount = 0;
  poisonOn?: string;
  observingPoison = false;
  normalCommandDeniedDuringVerification = false;
  failQueue: FaultAction[] = [];
  crashQueue: FaultAction[] = [];
  failPlan?: { action: string; occurrence: number };
  crashPlan?: { action: string; occurrence: number };
  crashAfterPlan?: { action: string; occurrence: number };
  readonly actionCounts = new Map<string, number>();
  readonly afterActionCounts = new Map<string, number>();
  verificationOverrides: Record<"v1" | "v2", Partial<OperationalVerification>> = { v1: {}, v2: {} };
  verificationServiceOverrides: Record<"v1" | "v2", {
    active?: boolean;
    pid?: number | null;
    execStart?: string;
    tools?: string[];
  }> = { v1: {}, v2: {} };
  normalVerificationOverrides: Record<"v1" | "v2", Partial<OperationalVerification>> = { v1: {}, v2: {} };
  readonly successfulStarts: Array<"v1" | "v2"> = [];
  pendingDatabasePair?: { target: OperationalTarget; before: [string, string]; state: string; history: string };
  readonly walSafeBackups: Array<{ version: "v1" | "v2"; state: string; history: string }> = [];
  restoredBackupEvidence?: DurablePairBackupEvidence;
  readonly retainedBundles = new Set([v1Target.bundle.path, v2Target.bundle.path]);
  readonly retainedRoots = new Set([v1Target.runtime.path, v2Target.runtime.path]);
  readonly stagedArtifacts = new Set<string>();

  constructor(private readonly journalPath: string, private readonly physicalStatePath?: string) {
    if (physicalStatePath && existsSync(physicalStatePath)) {
      const saved = JSON.parse(readFileSync(physicalStatePath, "utf8")) as {
        physical: PhysicalState;
        pendingDatabasePair?: FakeHost["pendingDatabasePair"];
        mcp: { codex: string; grok: string };
      };
      this.physical = saved.physical;
      if (saved.pendingDatabasePair) this.pendingDatabasePair = saved.pendingDatabasePair;
      this.mcp.codex = saved.mcp.codex;
      this.mcp.grok = saved.mcp.grok;
    } else {
      this.persistPhysical();
    }
  }

  persistPhysical(): void {
    if (!this.physicalStatePath) return;
    writeFileSync(this.physicalStatePath, `${JSON.stringify({
      physical: this.physical,
      pendingDatabasePair: this.pendingDatabasePair,
      mcp: this.mcp,
    }, null, 2)}\n`);
  }

  private record(action: string): void {
    try {
      const phase = JSON.parse(readFileSync(this.journalPath, "utf8")).phase as string;
      this.phaseBeforeAction.push({ action, phase });
    } catch { /* The journal is created during preflight. */ }
    this.actions.push(action);
    const occurrence = (this.actionCounts.get(action) ?? 0) + 1;
    this.actionCounts.set(action, occurrence);
    if (this.observingPoison && this.poisonOn === action) this.poisonCount += 1;
    if (this.crashPlan?.action === action && this.crashPlan.occurrence === occurrence) {
      throw new SimulatedCrash(action);
    }
    if (this.failPlan?.action === action && this.failPlan.occurrence === occurrence) {
      throw new Error(`injected failure at ${action} occurrence ${occurrence}`);
    }
    if (this.crashQueue[0] === action) {
      this.crashQueue.shift();
      throw new SimulatedCrash(action);
    }
    if (this.failQueue[0] === action) {
      this.failQueue.shift();
      throw new Error(`injected failure at ${action}`);
    }
  }

  failOn(action: string, occurrence = 1): void { this.failPlan = { action, occurrence }; }
  crashOn(action: string, occurrence = 1): void { this.crashPlan = { action, occurrence }; }
  crashAfter(action: string, occurrence = 1): void { this.crashAfterPlan = { action, occurrence }; }
  afterEffect(action: string | undefined): void {
    if (!action) return;
    const occurrence = (this.afterActionCounts.get(action) ?? 0) + 1;
    this.afterActionCounts.set(action, occurrence);
    if (this.crashAfterPlan?.action === action && this.crashAfterPlan.occurrence === occurrence) {
      throw new SimulatedCrash(`${action} effect`);
    }
  }

  async enterMaintenance(): Promise<void> { this.record("maintenance:on"); this.maintenance = true; }
  async leaveMaintenance(): Promise<void> { this.record("maintenance:off"); this.maintenance = false; }
  async acquireDispatcherLock(input: { mode: "exclusive"; path: string; nonce: string }): Promise<void> {
    this.record("lock:exclusive");
    expect(input.path).toMatch(/restore\.lock$/);
    if (this.dispatcherLock) throw new Error("dispatcher lock busy");
    this.dispatcherLock = input.mode;
  }
  async releaseDispatcherLock(): Promise<void> { this.record("lock:release"); this.dispatcherLock = undefined; }
  async verifyTarget(target: OperationalTarget): Promise<void> { this.record(`verify_target:${target.version}`); }
  async switchDispatcherConfig(target: OperationalTarget): Promise<void> {
    this.record(`dispatcher_config:${target.version}`);
    this.physical.dispatcherDigest = target.dispatcher.sha256;
  }
  async terminateLegacyProcesses(target: OperationalTarget): Promise<void> {
    this.record(`terminate_legacy:${target.version}`);
  }
  async assertSystemdInactive(target: OperationalTarget): Promise<void> {
    this.record(`systemd_inactive:${target.version}`);
    if (this.physical.service.active) throw new Error("systemd unit is still active");
  }
  async scanDatabaseHandles(target: OperationalTarget): Promise<void> {
    this.record(`scan_processes:${target.version}:pid,db,wal,shm`);
    if (this.physical.openDatabaseFds !== 0) throw new Error("database handles remain open");
  }
  async backupDatabasePair(target: OperationalTarget): Promise<DurablePairBackupEvidence> {
    this.record(`backup_pair:${target.version}`);
    this.walSafeBackups.push({
      version: target.version,
      state: this.physical.stateDatabase,
      history: this.physical.historyDatabase,
    });
    return {
      version: target.version,
      stateDatabase: { path: `/durable-backup/${target.version}/collaboration.db`, sha256: this.physical.stateDatabase },
      historyDatabase: { path: `/durable-backup/${target.version}/history.db`, sha256: this.physical.historyDatabase },
      wal: { checkpointed: true, sourceWalObserved: true, sourceShmObserved: true },
    };
  }
  async restoreDatabasePairFromBackup(evidence: DurablePairBackupEvidence): Promise<void> {
    this.record(`restore_backup_pair:${evidence.version}`);
    const before = [this.physical.stateDatabase, this.physical.historyDatabase] as const;
    try {
      this.record(`restore_state:${evidence.version}`);
      this.record(`restore_history:${evidence.version}`);
      this.physical.stateDatabase = evidence.stateDatabase.sha256;
      this.physical.historyDatabase = evidence.historyDatabase.sha256;
      this.restoredBackupEvidence = structuredClone(evidence);
    } catch (error) {
      this.physical.stateDatabase = before[0];
      this.physical.historyDatabase = before[1];
      this.record(`db_pair:abort:${evidence.version}`);
      throw error;
    }
  }
  async beginPoisonObservation(target: OperationalTarget): Promise<void> {
    this.record(`poison:begin:${target.version}:${target.poisonProviders.join(",")}`);
    this.poisonCount = 0;
    this.observingPoison = true;
  }
  async stop(target: OperationalTarget): Promise<void> {
    this.record(`stop:${target.version}`);
    this.physical.service.active = false;
    delete this.physical.service.pid;
  }
  async drain(target: OperationalTarget): Promise<void> {
    this.record(`drain:${target.version}`);
    this.physical.openDatabaseFds = 0;
  }
  async assertNoOpenDatabaseFds(target: OperationalTarget): Promise<void> {
    this.record(`fds_zero:${target.version}`);
    if (this.physical.openDatabaseFds !== 0) throw new Error("database fds remain open");
  }
  async stage(target: OperationalTarget): Promise<void> {
    this.record(`stage:${target.version}`);
    this.stagedArtifacts.add(`staged:${target.version}`);
  }
  async beginDatabasePairRestore(target: OperationalTarget): Promise<void> {
    this.record(`db_pair:begin:${target.version}`);
    this.pendingDatabasePair = {
      target,
      before: [this.physical.stateDatabase, this.physical.historyDatabase],
      state: this.physical.stateDatabase,
      history: this.physical.historyDatabase,
    };
  }
  async restoreStateDatabase(target: OperationalTarget): Promise<void> {
    this.record(`restore_state:${target.version}`);
    if (!this.pendingDatabasePair) throw new Error("database pair restore not begun");
    this.pendingDatabasePair.state = target.stateDatabase.sha256;
  }
  async restoreHistoryDatabase(target: OperationalTarget): Promise<void> {
    this.record(`restore_history:${target.version}`);
    if (!this.pendingDatabasePair) throw new Error("database pair restore not begun");
    this.pendingDatabasePair.history = target.historyDatabase.sha256;
  }
  async commitDatabasePairRestore(target: OperationalTarget): Promise<void> {
    this.record(`db_pair:commit:${target.version}`);
    if (!this.pendingDatabasePair || this.pendingDatabasePair.target.version !== target.version) {
      throw new Error("database pair restore target mismatch");
    }
    this.physical.stateDatabase = this.pendingDatabasePair.state;
    this.physical.historyDatabase = this.pendingDatabasePair.history;
    delete this.pendingDatabasePair;
  }
  async abortDatabasePairRestore(target: OperationalTarget): Promise<void> {
    this.record(`db_pair:abort:${target.version}`);
    delete this.pendingDatabasePair;
  }
  async switchRuntime(target: OperationalTarget): Promise<void> {
    this.record(`runtime:${target.version}`);
    this.physical.runtimeSymlink = target.runtime.path;
  }
  async installUnit(target: OperationalTarget): Promise<void> {
    this.record(`unit:${target.version}`);
    this.physical.unitDigest = target.unit.sha256;
  }
  async daemonReload(): Promise<void> { this.record("daemon_reload"); }
  async patchMcp(target: OperationalTarget): Promise<void> {
    this.record(`mcp:${target.version}`);
    const stable = target.dispatcher.mcpRegistration;
    this.mcp.codex = this.mcp.codex.replace(/agent-collab=[^\n]+/, `agent-collab=${stable}`);
    this.mcp.grok = this.mcp.grok.replace(/agent-collab=[^\n]+/, `agent-collab=${stable}`);
    this.physical.dispatcherDigest = target.dispatcher.sha256;
  }
  async acquireVerificationUnitLock(): Promise<void> {
    this.record("verify_lock:acquire");
    if (this.verificationLock) throw new Error("verification lock busy");
    this.verificationLock = true;
  }
  async releaseVerificationUnitLock(): Promise<void> {
    this.record("verify_lock:release");
    this.verificationLock = false;
  }
  async start(target: OperationalTarget): Promise<void> {
    this.record(`start:${target.version}`);
    const durable = JSON.parse(readFileSync(this.journalPath, "utf8")) as { phase: string };
    if (this.dispatcherLock !== undefined || this.maintenance) {
      throw new Error("normal start requires committed state without maintenance or exclusive lock");
    }
    if (!["committed_start_pending", "compensated_start_pending"].includes(durable.phase)) {
      throw new Error("normal start before durable commit");
    }
    this.physical.service = {
      active: true,
      pid: target.version === "v1" ? 1001 : 2002,
      execStart: `${target.dispatcher.path} worker`,
    };
    this.successfulStarts.push(target.version);
  }
  async startVerification(target: OperationalTarget, input?: { nonce: string; argv: string[] }): Promise<void> {
    this.record(`start_verification:${target.version}`);
    if (this.dispatcherLock !== undefined || !this.maintenance) {
      throw new Error("verification unit requires released dispatcher lock and active maintenance");
    }
    if (!input) throw new Error("verification unit requires nonce-bound argv");
    expect(input.argv).toEqual([target.dispatcher.path, "verify-unit", "--nonce", input.nonce]);
    try { this.runNormalCommand(); } catch {
      this.normalCommandDeniedDuringVerification = true;
    }
    this.physical.verificationService = {
      active: true,
      pid: target.version === "v1" ? 1101 : 2202,
      execStart: `${target.dispatcher.path} verify-unit --nonce ${input.nonce}`,
    };
    this.physical.openDatabaseFds = 2;
  }
  async stopVerification(target: OperationalTarget): Promise<void> {
    this.record(`stop_verification:${target.version}`);
    delete this.physical.verificationService;
  }
  async drainVerification(target: OperationalTarget): Promise<void> {
    this.record(`drain_verification:${target.version}`);
    this.physical.openDatabaseFds = 0;
  }
  async issuePermit(input: { action: OperationalPermitAction; nonce: string }): Promise<string> {
    this.record(`permit:${input.action}`);
    if (this.dispatcherLock !== undefined || !this.maintenance) {
      throw new Error("verification permits require released dispatcher lock and active maintenance");
    }
    const durable = JSON.parse(readFileSync(this.journalPath, "utf8")) as { nonce: string };
    if (input.nonce !== durable.nonce) throw new Error("permit nonce is not journal-authorized");
    const permit = `${input.action}:${input.nonce}:${this.permits.size}`;
    this.permits.set(permit, { ...input, used: false });
    return permit;
  }
  private consume(action: OperationalPermitAction, nonce: string, permit: string): void {
    const grant = this.permits.get(permit);
    if (!grant || grant.action !== action || grant.nonce !== nonce) throw new Error("wrong action-bound permit");
    if (grant.used) throw new Error("permit replay");
    grant.used = true;
  }
  async isActive(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<boolean> {
    this.record(`is_active:${target.version}`);
    this.consume("is_active", auth.nonce, auth.permit);
    return this.verificationServiceOverrides[target.version].active ?? this.physical.verificationService?.active ?? false;
  }
  async pid(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<number | undefined> {
    this.record(`pid:${target.version}`);
    this.consume("pid", auth.nonce, auth.permit);
    const override = this.verificationServiceOverrides[target.version].pid;
    return override === null ? undefined : override ?? this.physical.verificationService?.pid;
  }
  async execStart(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<string> {
    this.record(`exec_start:${target.version}`);
    this.consume("exec_start", auth.nonce, auth.permit);
    return this.verificationServiceOverrides[target.version].execStart ??
      this.physical.verificationService?.execStart ?? "";
  }
  async mcpInitialize(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<void> {
    this.record(`mcp_initialize:${target.version}`);
    this.consume("mcp_initialize", auth.nonce, auth.permit);
  }
  async mcpListTools(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<string[]> {
    this.record(`mcp_list_tools:${target.version}`);
    this.consume("mcp_list_tools", auth.nonce, auth.permit);
    return this.verificationServiceOverrides[target.version].tools ?? ["collab_status", "collab_delegate"];
  }
  async endPoisonObservation(target: OperationalTarget): Promise<number> {
    this.record(`poison:end:${target.version}`);
    this.observingPoison = false;
    return this.poisonCount;
  }
  async verifyPhysical(target: OperationalTarget): Promise<OperationalVerification> {
    this.record(`verify_physical:${target.version}`);
    return {
      terminal: true,
      success: this.physical.stateDatabase === target.stateDatabase.sha256 &&
        this.physical.historyDatabase === target.historyDatabase.sha256 &&
        this.physical.runtimeSymlink === target.runtime.path &&
        this.physical.unitDigest === target.unit.sha256 &&
        this.physical.dispatcherDigest === target.dispatcher.sha256,
      targetVersion: target.version,
      poisonProviderCount: this.poisonCount,
      ...this.verificationOverrides[target.version],
    };
  }
  async cleanup(target: OperationalTarget): Promise<void> {
    this.record(`cleanup:${target.version}`);
    this.stagedArtifacts.delete(`staged:${target.version}`);
  }
  async commit(target: OperationalTarget): Promise<void> { this.record(`commit:${target.version}`); }
  async verifyNormalService(target: OperationalTarget): Promise<OperationalVerification> {
    this.record(`verify_normal:${target.version}`);
    return {
      terminal: true,
      success: this.physical.service.active &&
        this.physical.service.pid !== undefined &&
        this.physical.service.execStart === `${target.dispatcher.path} worker`,
      targetVersion: target.version,
      poisonProviderCount: 0,
      ...this.normalVerificationOverrides[target.version],
    };
  }
  async handoffRestartRequired(target: OperationalTarget): Promise<string[]> {
    this.record(`handoff_restart:${target.version}`);
    return ["codex", "grok"];
  }

  runNormalCommand(): void {
    const phase = existsSync(this.journalPath)
      ? (JSON.parse(readFileSync(this.journalPath, "utf8")) as { phase: string }).phase
      : undefined;
    if ((phase && !["committed", "compensated"].includes(phase)) ||
        this.maintenance || this.dispatcherLock === "exclusive") throw new Error("maintenance in progress");
    this.dispatcherLock = "shared";
    this.actions.push("normal_command");
    this.dispatcherLock = undefined;
  }
}

function fixture(overrides: { v1?: OperationalTarget; v2?: OperationalTarget } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-operational-restore-"));
  roots.push(root);
  const journalPath = join(root, "restore-journal.json");
  const lockPath = join(root, "restore.lock");
  const physicalStatePath = join(root, "physical-state.json");
  const observe = (host: FakeHost) => new Proxy(host, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || property === "runNormalCommand") return value;
      return async (...args: unknown[]) => {
        const actionOffset = target.actions.length;
        const result = await (value as (...callArgs: unknown[]) => unknown).apply(target, args);
        target.persistPhysical();
        target.afterEffect(target.actions[actionOffset]);
        return result;
      };
    },
  }) as OperationalHost;
  const host = new FakeHost(journalPath, physicalStatePath);
  const observedHost = observe(host);
  const restore = new OperationalRestore({
    host: observedHost, journalPath, lockPath,
    v1Target: overrides.v1 ?? v1Target, v2Target: overrides.v2 ?? v2Target,
  });
  const recreate = () => {
    const recreatedHost = new FakeHost(journalPath, physicalStatePath);
    const recreatedObservedHost = observe(recreatedHost);
    return {
      host: recreatedHost,
      restore: new OperationalRestore({
        host: recreatedObservedHost, journalPath, lockPath,
        v1Target: overrides.v1 ?? v1Target, v2Target: overrides.v2 ?? v2Target,
      }),
    };
  };
  return { journalPath, lockPath, physicalStatePath, host, observedHost, restore, recreate };
}

const journal = (path: string) => JSON.parse(readFileSync(path, "utf8")) as {
  action: string; nonce: string; phase: string; v1Target: OperationalTarget; v2Target: OperationalTarget;
  restoreNonceConsumed: boolean;
  permits: Record<OperationalPermitAction, { nonce: string; consumed: boolean }>;
  lastProvenPhase?: string;
  operatorActions?: string[];
  restartRequiredClients?: string[];
  currentV2Backup?: DurablePairBackupEvidence;
};

afterEach(() => {
  for (const pid of managedServicePids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ }
  }
  managedServicePids.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("state-v4 restore guard", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-state-v4-guard-"));
    roots.push(root);
    const journalPath = join(root, "state-v4-backup.jsonl");
    const create = (faultInjector?: ConstructorParameters<typeof StateV4RestoreGuard>[0]["faultInjector"]) =>
      new StateV4RestoreGuard({
        journalPath,
        databaseIdentity: digest("a"),
        backupSha256: digest("b"),
        tableDigestManifestSha256: digest("c"),
        writeEpoch: digest("d"),
        ...(faultInjector ? { faultInjector } : {}),
      });
    return { root, journalPath, create };
  };

  it("persists a canonical hash chain and forbids restore after service reopen", () => {
    const fx = fixture();
    const guard = fx.create();
    const backup = guard.createBackupRecord(1);
    expect(backup.event).toBe("backup_created");
    expect(assertPhysicalRestoreAllowed({ writeEpoch: digest("d"), tableDigestManifestSha256: digest("c") },
      guard.readAndVerify(), {
      writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c"),
    })).toEqual(backup);
    const reopened = guard.append("service_reopened", 2);
    expect(reopened.previousRecordSha256).toBe(backup.recordSha256);
    expect(guard.readAndVerify().map(({ event }) => event)).toEqual([
      "backup_created", "service_reopened",
    ]);
    expect(() => assertPhysicalRestoreAllowed({ writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c") }, guard.readAndVerify())).toThrow(/forbidden after reopen/i);
  });

  it("durably consumes the only legal restore and rejects replay", () => {
    const guard = fixture().create();
    guard.createBackupRecord(1);
    expect(guard.append("restore_consumed", 2).event).toBe("restore_consumed");
    expect(() => guard.append("restore_consumed", 3)).toThrow(/already consumed/i);
    expect(() => assertPhysicalRestoreAllowed({ writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c") }, guard.readAndVerify())).toThrow(/prior restore/i);
  });

  it.each([
    "after_guard_temp_write",
    "after_guard_file_fsync",
    "after_guard_rename",
    "after_guard_directory_fsync",
  ] as const)("fails closed at %s", (point) => {
    const fx = fixture();
    const guard = fx.create((actual) => {
      if (actual === point) throw new Error(`fault:${point}`);
    });
    expect(() => guard.createBackupRecord(1)).toThrow(`fault:${point}`);
    expect(() => assertPhysicalRestoreAllowed({ writeEpoch: digest("d"),
      tableDigestManifestSha256: digest("c") }, fx.create().readAndVerify()))
      .toThrow(/missing|truncated|malformed|interrupted/i);
  });

  it("rejects truncation, reordered identities, and noncanonical bytes", () => {
    const fx = fixture();
    const guard = fx.create();
    guard.createBackupRecord(1);
    const valid = readFileSync(fx.journalPath, "utf8");
    writeFileSync(fx.journalPath, valid.slice(0, -1));
    expect(() => guard.readAndVerify()).toThrow(/truncated/i);
    writeFileSync(fx.journalPath, valid.replace("{", "{ "));
    expect(() => guard.readAndVerify()).toThrow(/canonical|identity|hash/i);
  });
});

const successOrder = [
  "dispatcher_config:v1", "stop:v2", "terminate_legacy:v2", "drain:v2", "systemd_inactive:v2",
  "fds_zero:v2", "scan_processes:v2:pid,db,wal,shm", "verify_target:v1", "verify_target:v2", "backup_pair:v2",
  "stage:v1", "db_pair:begin:v1", "restore_state:v1", "restore_history:v1", "db_pair:commit:v1",
  "runtime:v1", "unit:v1", "daemon_reload", "mcp:v1", "verify_lock:acquire", "lock:release",
  "start_verification:v1",
  "permit:is_active", "is_active:v1", "permit:pid", "pid:v1", "permit:exec_start", "exec_start:v1",
  "permit:mcp_initialize", "mcp_initialize:v1",
  "permit:mcp_list_tools", "mcp_list_tools:v1", "verify_physical:v1", "stop_verification:v1",
  "drain_verification:v1", "fds_zero:v1", "poison:end:v1", "verify_lock:release", "lock:exclusive",
  "cleanup:v1", "commit:v1", "lock:release", "maintenance:off", "start:v1", "verify_normal:v1",
  "handoff_restart:v1",
];

const compensationOrder = [
  "poison:begin:v2:claude,codex,grok", "dispatcher_config:v2", "stop:v1", "terminate_legacy:v1",
  "drain:v1", "systemd_inactive:v1", "fds_zero:v1", "scan_processes:v1:pid,db,wal,shm", "verify_target:v2",
  "backup_pair:v1", "stage:v2", "restore_backup_pair:v2", "restore_state:v2", "restore_history:v2",
  "runtime:v2", "unit:v2", "daemon_reload", "mcp:v2",
  "verify_lock:acquire", "lock:release", "start_verification:v2", "permit:is_active", "is_active:v2", "permit:pid", "pid:v2",
  "permit:exec_start", "exec_start:v2", "permit:mcp_initialize", "mcp_initialize:v2",
  "permit:mcp_list_tools", "mcp_list_tools:v2", "verify_physical:v2", "stop_verification:v2",
  "drain_verification:v2", "fds_zero:v2", "poison:end:v2", "verify_lock:release", "lock:exclusive",
  "cleanup:v2", "commit:v2", "lock:release", "maintenance:off", "start:v2", "verify_normal:v2",
];

const v1PhysicalBoundaries = [
  ["dispatcher_config:v1", "preflight", 1],
  ["stop:v2", "dispatcher_configured", 1],
  ["terminate_legacy:v2", "service_stopped", 1],
  ["drain:v2", "legacy_terminated", 1],
  ["systemd_inactive:v2", "service_drained", 1],
  ["fds_zero:v2", "systemd_inactive", 1],
  ["scan_processes:v2:pid,db,wal,shm", "fds_zero", 1],
  ["backup_pair:v2", "targets_revalidated", 1],
  ["stage:v1", "current_v2_backed_up", 1],
  ["db_pair:begin:v1", "staged", 1],
  ["restore_state:v1", "pair_restore_started", 1],
  ["restore_history:v1", "state_restored", 1],
  ["db_pair:commit:v1", "history_restored", 1],
  ["runtime:v1", "data_restored", 1],
  ["unit:v1", "runtime_switched", 1],
  ["daemon_reload", "unit_installed", 1],
  ["mcp:v1", "daemon_reloaded", 1],
  ["verify_lock:acquire", "mcp_patched", 1],
  ["lock:release", "verification_lock_acquired", 1],
  ["start_verification:v1", "verifying", 1],
  ["stop_verification:v1", "physical_verified", 1],
  ["drain_verification:v1", "verification_stopped", 1],
  ["fds_zero:v1", "verification_drained", 1],
  ["poison:end:v1", "verification_fds_zero", 1],
  ["verify_lock:release", "poison_proven", 1],
  ["lock:exclusive", "verification_lock_released", 2],
  ["cleanup:v1", "commit_lock_acquired", 1],
  ["commit:v1", "cleaned", 1],
  ["lock:release", "committed_start_pending", 2],
  ["maintenance:off", "committed_start_pending", 1],
  ["start:v1", "committed_start_pending", 1],
  ["verify_normal:v1", "normal_started", 1],
  ["handoff_restart:v1", "normal_verified", 1],
] as const;

const compensationEvidenceMatrix = [
  ["poison:begin:v2:claude,codex,grok", 1, "compensating", "v1"],
  ["dispatcher_config:v2", 1, "compensation_poison_observing", "v1"],
  ["stop:v1", 1, "compensation_dispatcher_configured", "v1"],
  ["terminate_legacy:v1", 1, "compensation_service_stopped", "v1"],
  ["drain:v1", 1, "compensation_legacy_terminated", "v1"],
  ["systemd_inactive:v1", 1, "compensation_service_drained", "v1"],
  ["fds_zero:v1", 1, "compensation_systemd_inactive", "v1"],
  ["scan_processes:v1:pid,db,wal,shm", 1, "compensation_fds_zero", "v1"],
  ["verify_target:v2", 3, "compensation_quiesced", "v1"],
  ["backup_pair:v1", 1, "compensation_target_revalidated", "v1"],
  ["stage:v2", 1, "compensation_current_v1_backed_up", "v1"],
  ["restore_backup_pair:v2", 1, "compensation_staged", "v1"],
  ["restore_state:v2", 1, "compensation_staged", "v1"],
  ["restore_history:v2", 1, "compensation_staged", "v1"],
  ["runtime:v2", 1, "compensation_data_restored", "v2"],
  ["unit:v2", 1, "compensation_runtime_switched", "v2"],
  ["daemon_reload", 1, "compensation_unit_installed", "v2"],
  ["mcp:v2", 1, "compensation_daemon_reloaded", "v2"],
  ["verify_lock:acquire", 1, "compensation_mcp_patched", "v2"],
  ["lock:release", 1, "compensation_verification_lock_acquired", "v2"],
  ["start_verification:v2", 1, "compensation_verifying", "v2"],
  ["permit:is_active", 1, "compensation_verification_started", "v2"],
  ["is_active:v2", 1, "compensation_verification_started", "v2"],
  ["permit:pid", 1, "compensation_active_verified", "v2"],
  ["pid:v2", 1, "compensation_active_verified", "v2"],
  ["permit:exec_start", 1, "compensation_pid_verified", "v2"],
  ["exec_start:v2", 1, "compensation_pid_verified", "v2"],
  ["permit:mcp_initialize", 1, "compensation_exec_start_verified", "v2"],
  ["mcp_initialize:v2", 1, "compensation_exec_start_verified", "v2"],
  ["permit:mcp_list_tools", 1, "compensation_mcp_initialized", "v2"],
  ["mcp_list_tools:v2", 1, "compensation_mcp_initialized", "v2"],
  ["verify_physical:v2", 1, "compensation_mcp_tools_verified", "v2"],
  ["stop_verification:v2", 1, "compensation_physical_verified", "v2"],
  ["drain_verification:v2", 1, "compensation_verification_stopped", "v2"],
  ["fds_zero:v2", 2, "compensation_verification_drained", "v2"],
  ["poison:end:v2", 1, "compensation_verification_fds_zero", "v2"],
  ["verify_lock:release", 1, "compensation_poison_proven", "v2"],
  ["lock:exclusive", 2, "compensation_verification_lock_released", "v2"],
  ["cleanup:v2", 1, "compensation_commit_lock_acquired", "v2"],
  ["commit:v2", 1, "compensation_cleaned", "v2"],
  ["lock:release", 2, "compensated_start_pending", "v2"],
  ["maintenance:off", 1, "compensated_start_pending", "v2"],
  ["start:v2", 1, "compensated_start_pending", "v2"],
  ["verify_normal:v2", 1, "compensation_normal_started", "v2"],
] as const;

const stableDispatcherSource = join(process.cwd(), "src", "migration", "stable-dispatcher.ts");
const databasePairModulePath = join(process.cwd(), "src", "migration", "database-pair.ts");
const operationalRunnerSource = join(process.cwd(), "src", "migration", "operational-runner.ts");
const journalWriterSource = join(process.cwd(), "src", "migration", "journal-writer.ts");
const operationalHostSource = join(process.cwd(), "src", "migration", "operational-host.ts");

interface DatabasePairModule {
  replaceDatabasePairAtomically(input: Record<string, unknown>): Promise<void>;
  recoverDatabasePairReplacement(input: Record<string, unknown>): Promise<void>;
  abortDatabasePairReplacement(input: Record<string, unknown>): Promise<void>;
}

async function loadDatabasePairModule(): Promise<DatabasePairModule> {
  return await import(databasePairModulePath) as DatabasePairModule;
}

const databaseLabel = (path: string) => {
  const database = new Database(path, { readonly: true });
  try {
    return database.prepare("SELECT value FROM identity ORDER BY rowid DESC LIMIT 1").pluck().get() as string;
  } finally {
    database.close();
  }
};

const fileSha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function createDatabase(path: string, label: string): void {
  const database = new Database(path);
  database.exec("CREATE TABLE identity(value TEXT NOT NULL)");
  database.prepare("INSERT INTO identity(value) VALUES (?)").run(label);
  database.close();
}

function createCrashWalDatabase(path: string, label: string): void {
  const script = `
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.pragma("journal_mode = WAL");
db.pragma("wal_autocheckpoint = 0");
db.exec("CREATE TABLE identity(value TEXT NOT NULL)");
db.prepare("INSERT INTO identity(value) VALUES (?)").run(process.argv[2]);
process.kill(process.pid, "SIGKILL");
`;
  const result = spawnSync(process.execPath, ["-e", script, path, label], { cwd: process.cwd() });
  expect(result.signal).toBe("SIGKILL");
  expect(existsSync(`${path}-wal`)).toBe(true);
  expect(existsSync(`${path}-shm`)).toBe(true);
}

function sqlitePairFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-sqlite-pair-"));
  roots.push(root);
  const currentV2Root = join(root, "v2-retained");
  const targetV1Root = join(root, "v1-retained");
  const stagingRoot = join(root, "staging");
  const activeLink = join(root, "active");
  const journalPath = join(root, "pair-journal.json");
  mkdirSync(currentV2Root);
  mkdirSync(targetV1Root);
  mkdirSync(stagingRoot);
  createCrashWalDatabase(join(currentV2Root, "collaboration.db"), "v2-state");
  createCrashWalDatabase(join(currentV2Root, "history.db"), "v2-history");
  createCrashWalDatabase(join(targetV1Root, "collaboration.db"), "v1-state-wal");
  createCrashWalDatabase(join(targetV1Root, "history.db"), "v1-history-wal");
  symlinkSync(currentV2Root, activeLink, "dir");
  const input = {
    activeLink,
    currentRoot: currentV2Root,
    targetRoot: targetV1Root,
    stagingRoot,
    journalPath,
    files: { state: "collaboration.db", history: "history.db" },
  };
  const labels = () => ({
    state: databaseLabel(join(activeLink, "collaboration.db")),
    history: databaseLabel(join(activeLink, "history.db")),
  });
  return { root, currentV2Root, targetV1Root, stagingRoot, activeLink, journalPath, input, labels };
}

function subprocessFixture(
  phase: "verifying" | "committed" | "compensated" | "committed_start_pending" |
    "compensated_start_pending" = "verifying",
  selectedTarget?: "v1" | "v2",
) {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-dispatcher-subprocess-"));
  roots.push(root);
  const journalPath = join(root, "restore-journal.json");
  const lockPath = join(root, "restore.lock");
  const poisonPath = join(root, "poison-count.txt");
  const runtimeLogPath = join(root, "runtime.log");
  const databaseOpenPath = join(root, "database-open.log");
  const credentialLeakPath = join(root, "credential-leak.log");
  const runtimePath = join(root, "runtime.mjs");
  const poisonProviderPath = join(root, "poison-provider.mjs");
  const managedServiceChildPath = join(root, "managed-service-child.mjs");
  const managedServiceStatePath = join(root, "managed-service-state.json");
  writeFileSync(runtimePath, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const input = readFileSync(0, "utf8");
appendFileSync(process.env.DATABASE_OPEN_PATH, "opened\\n");
appendFileSync(process.env.RUNTIME_LOG_PATH, JSON.stringify({ argv, input }) + "\\n");
const injectProviderPoison = (action) => {
  if (process.env.POISON_INJECT_ACTION !== action) return;
  const providerEnv = process.env.POISON_INJECT_PROVIDER_ENV;
  const providerBin = providerEnv && process.env[providerEnv];
  if (!providerBin) process.exit(94);
  spawnSync(providerBin, [action], { env: process.env, stdio: "ignore" });
};
if (process.env.RUNTIME_BARRIER_PATH) {
  appendFileSync(process.env.RUNTIME_BARRIER_PATH, process.pid + "\\n");
  const deadline = Date.now() + 2000;
  while (readFileSync(process.env.RUNTIME_BARRIER_PATH, "utf8").trim().split("\\n").filter(Boolean).length < 2) {
    if (Date.now() > deadline) process.exit(95);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
if (process.env.RUNTIME_HOLD_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.RUNTIME_HOLD_MS)));
const leaked = ["OPENAI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY"].filter((key) => process.env[key]);
if (leaked.length) appendFileSync(process.env.CREDENTIAL_LEAK_PATH, leaked.join(",") + "\\n");
if (argv[0] === "verify-unit") {
  injectProviderPoison("startup");
  if (argv[1] !== "--nonce" || argv[2] !== process.env.EXPECTED_NONCE) process.exit(96);
}
if (argv[0] === "status") {
  injectProviderPoison("status");
  console.log(JSON.stringify({ protocol: "agent-collab/v1", targetVersion: process.env.TARGET_VERSION }));
} else if (argv[0] === "mcp") {
  for (const line of input.trim().split("\\n").filter(Boolean)) {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      injectProviderPoison("mcp_initialize");
      console.log(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "agent-collab", version: "v1" } },
      }));
    } else if (request.method === "tools/list") {
      injectProviderPoison("mcp_list_tools");
      console.log(JSON.stringify({
        jsonrpc: "2.0", id: request.id,
        result: { tools: [{ name: "collab_status" }, { name: "collab_delegate" }] },
      }));
    }
  }
} else {
  console.log(JSON.stringify({ started: argv[0], targetVersion: process.env.TARGET_VERSION }));
  if (argv[0] === "worker" && process.env.AGENT_COLLAB_MANAGED_SERVICE === "1") {
    setInterval(() => {}, 1000);
  }
}
`);
  writeFileSync(poisonProviderPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.POISON_PATH, "1");
process.exit(97);
`);
  writeFileSync(managedServiceChildPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [statePath, executable, ...argv] = process.argv.slice(2);
const child = spawn(executable, argv, {
  env: { ...process.env, AGENT_COLLAB_MANAGED_SERVICE: "1" }, stdio: "ignore",
});
const persist = (isActive, terminal = {}) => writeFileSync(statePath, JSON.stringify({
  managerPid: process.pid, workerPid: child.pid, isActive,
  execStart: [executable, ...argv].join(" "), ...terminal,
}) + "\\n");
persist(true);
child.on("exit", (exitCode, signal) => persist(false, { exitCode, signal }));
const shutdown = () => { try { child.kill("SIGTERM"); } catch {} process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1000);
`);
  chmodSync(runtimePath, 0o755);
  chmodSync(poisonProviderPath, 0o755);
  chmodSync(managedServiceChildPath, 0o755);
  writeFileSync(poisonPath, "");
  const nonce = "verification-nonce";
  const targetVersion = selectedTarget ?? (phase.startsWith("compensated") ? "v2" : "v1");
  writeFileSync(journalPath, `${JSON.stringify({
    action: "restore_v1",
    nonce,
    phase,
    targetVersion,
    permits: {
      is_active: { nonce, token: "status-token", consumed: false },
      start_verification: { nonce, token: "verify-unit-token", consumed: false },
      mcp_initialize: { nonce, token: "mcp-init-token", consumed: false },
      mcp_list_tools: { nonce, token: "mcp-tools-token", consumed: false },
      start_normal: { nonce, token: "start-normal-token", consumed: false, targetVersion },
      prove_normal: { nonce, token: "prove-normal-token", consumed: false, targetVersion },
    },
  }, null, 2)}\n`);
  const env = {
    ...process.env,
    AGENT_COLLAB_RESTORE_JOURNAL: journalPath,
    AGENT_COLLAB_RESTORE_LOCK: lockPath,
    AGENT_COLLAB_ACTIVE_RUNTIME: runtimePath,
    RUNTIME_LOG_PATH: runtimeLogPath,
    DATABASE_OPEN_PATH: databaseOpenPath,
    CREDENTIAL_LEAK_PATH: credentialLeakPath,
    EXPECTED_NONCE: nonce,
    TARGET_VERSION: targetVersion,
    POISON_PATH: poisonPath,
    CLAUDE_CODE_BIN: poisonProviderPath,
    CODEX_BIN: poisonProviderPath,
    GROK_BIN: poisonProviderPath,
    OPENAI_API_KEY: "must-not-cross-dispatcher",
    XAI_API_KEY: "must-not-cross-dispatcher",
    ANTHROPIC_API_KEY: "must-not-cross-dispatcher",
  };
  const run = (args: string[], input?: string, envOverrides: Record<string, string> = {}) => spawnSync(
    process.execPath,
    ["--experimental-strip-types", stableDispatcherSource, ...args],
    { encoding: "utf8", env: { ...env, ...envOverrides }, input, timeout: 5_000 },
  );
  const spawnRun = (args: string[], input?: string, envOverrides: Record<string, string> = {}) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", stableDispatcherSource, ...args], {
      env: { ...env, ...envOverrides }, stdio: ["pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    return child;
  };
  return {
    root, journalPath, lockPath, poisonPath, runtimeLogPath, databaseOpenPath, credentialLeakPath,
    runtimePath, managedServiceChildPath, managedServiceStatePath, nonce, targetVersion, env, run, spawnRun,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

const runtimeRecords = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    argv: string[]; input: string;
  })
  : [];

describe("stable dispatcher subprocess gate", () => {
  it.each([
    ["restore_v1", "committed", "v1"],
    ["compensate_v2", "compensated", "v2"],
  ] as const)("RB-14 runner %s creates and consumes all lifecycle permits through one journal", (action, finalPhase, target) => {
    const fx = subprocessFixture();
    rmSync(fx.journalPath);
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    expect(existsSync(operationalRunnerSource), "operational runner source must exist").toBe(true);
    const inputPath = join(fx.root, "runner-input.json");
    writeFileSync(inputPath, `${JSON.stringify({
      action,
      journalPath: fx.journalPath,
      lockPath: fx.lockPath,
      dispatcherSource: stableDispatcherSource,
      activeRuntime: fx.runtimePath,
      managedServiceChild: fx.managedServiceChildPath,
      managedServiceState: fx.managedServiceStatePath,
      v1Target,
      v2Target,
    }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", operationalRunnerSource, "run", "--input", inputPath,
    ], { encoding: "utf8", env: fx.env, timeout: 10_000 });
    expect(result.status).toBe(0);
    const durable = JSON.parse(readFileSync(fx.journalPath, "utf8")) as {
      phase: string;
      permits: Record<string, { consumed: boolean; nonce: string; token: string; targetVersion?: string }>;
    };
    expect(durable.phase).toBe(finalPhase);
    expect(Object.keys(durable.permits).sort()).toEqual([
      "exec_start", "is_active", "mcp_initialize", "mcp_list_tools", "pid",
      "prove_normal", "start_normal", "start_verification",
    ]);
    expect(Object.values(durable.permits).every((permit) => permit.consumed)).toBe(true);
    expect(durable.permits.start_normal?.targetVersion).toBe(target);
    const service = JSON.parse(readFileSync(fx.managedServiceStatePath, "utf8")) as {
      managerPid: number; workerPid: number; isActive: boolean; execStart: string;
    };
    managedServicePids.add(service.managerPid);
    expect(service.isActive).toBe(true);
    expect(() => process.kill(service.managerPid, 0)).not.toThrow();
    expect(() => process.kill(service.workerPid, 0)).not.toThrow();
    const startPermit = durable.permits.start_normal!;
    expect(service.execStart).toBe([
      process.execPath, "--experimental-strip-types", stableDispatcherSource, "start-normal",
      "--target", target, "--action", "start_normal", "--nonce", startPermit.nonce,
      "--permit", startPermit.token,
    ].join(" "));
  });

  it.each([
    ["committed_start_pending", "committed", "v1"],
    ["compensated_start_pending", "compensated", "v2"],
  ] as const)("RB-14 fresh runner proves an already-active %s service without a second start", (phase, finalPhase, target) => {
    const fx = subprocessFixture(phase);
    expect(existsSync(operationalRunnerSource), "operational runner source must exist").toBe(true);
    const inputPath = join(fx.root, "recover-start-input.json");
    writeFileSync(inputPath, `${JSON.stringify({
      action: "recover",
      target,
      journalPath: fx.journalPath,
      lockPath: fx.lockPath,
      dispatcherSource: stableDispatcherSource,
      activeRuntime: fx.runtimePath,
      managedServiceChild: fx.managedServiceChildPath,
      managedServiceState: fx.managedServiceStatePath,
      v1Target,
      v2Target,
    }, null, 2)}\n`);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", operationalRunnerSource, "recover", "--input", inputPath,
    ], {
      encoding: "utf8", env: { ...fx.env, AGENT_COLLAB_OPERATIONAL_FAILPOINT: "after_normal_start" },
      timeout: 10_000,
    });
    expect(crashed.signal).toBe("SIGKILL");
    const durableAfterCrash = JSON.parse(readFileSync(fx.journalPath, "utf8")) as {
      phase: string;
      permits: Record<string, { nonce: string; token: string; targetVersion?: string }>;
    };
    const service = JSON.parse(readFileSync(fx.managedServiceStatePath, "utf8")) as {
      managerPid: number; workerPid: number; isActive: boolean; execStart: string;
    };
    managedServicePids.add(service.managerPid);
    expect(service).toMatchObject({ isActive: true });
    expect(() => process.kill(service.managerPid, 0)).not.toThrow();
    expect(() => process.kill(service.workerPid, 0)).not.toThrow();
    const startPermit = durableAfterCrash.permits.start_normal!;
    const expectedExecStart = [
      process.execPath, "--experimental-strip-types", stableDispatcherSource, "start-normal",
      "--target", target, "--action", "start_normal", "--nonce", startPermit.nonce,
      "--permit", startPermit.token,
    ].join(" ");
    expect(service.execStart).toBe(expectedExecStart);
    expect(durableAfterCrash.phase).toBe("normal_started_pending_proof");
    const startsBefore = runtimeRecords(fx.runtimeLogPath).filter((record) => record.argv[0] === "worker").length;
    expect(startsBefore).toBe(1);
    const recovered = spawnSync(process.execPath, [
      "--experimental-strip-types", operationalRunnerSource, "recover", "--input", inputPath,
    ], { encoding: "utf8", env: fx.env, timeout: 10_000 });
    expect(recovered.status).toBe(0);
    expect((JSON.parse(readFileSync(fx.journalPath, "utf8")) as { phase: string }).phase).toBe(finalPhase);
    const recoveredService = JSON.parse(readFileSync(fx.managedServiceStatePath, "utf8")) as {
      managerPid: number; workerPid: number; isActive: boolean; execStart: string;
    };
    expect(recoveredService).toEqual(service);
    expect(recoveredService.execStart).toBe(expectedExecStart);
    expect(() => process.kill(recoveredService.managerPid, 0)).not.toThrow();
    expect(() => process.kill(recoveredService.workerPid, 0)).not.toThrow();
    expect(runtimeRecords(fx.runtimeLogPath).filter((record) => record.argv[0] === "worker")).toHaveLength(1);
  });

  it.each([
    ["AGENT_COLLAB_CLAUDE_BIN", "claude", "startup"],
    ["AGENT_COLLAB_CLAUDE_BIN", "claude", "status"],
    ["AGENT_COLLAB_CLAUDE_BIN", "claude", "mcp_initialize"],
    ["AGENT_COLLAB_CLAUDE_BIN", "claude", "mcp_list_tools"],
    ["AGENT_COLLAB_CODEX_BIN", "codex", "startup"],
    ["AGENT_COLLAB_CODEX_BIN", "codex", "status"],
    ["AGENT_COLLAB_CODEX_BIN", "codex", "mcp_initialize"],
    ["AGENT_COLLAB_CODEX_BIN", "codex", "mcp_list_tools"],
    ["AGENT_COLLAB_GROK_BIN", "grok", "startup"],
    ["AGENT_COLLAB_GROK_BIN", "grok", "status"],
    ["AGENT_COLLAB_GROK_BIN", "grok", "mcp_initialize"],
    ["AGENT_COLLAB_GROK_BIN", "grok", "mcp_list_tools"],
  ] as const)("RB-16 ordinary restore detects %s poison from %s during %s and compensates", (envName, provider, probeAction) => {
    const fx = subprocessFixture();
    rmSync(fx.journalPath);
    expect(existsSync(operationalRunnerSource), "operational runner source must exist").toBe(true);
    const providerLog = join(fx.root, "negative-provider.log");
    const providerBin = join(fx.root, `${provider}-poison.mjs`);
    writeFileSync(providerBin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.NEGATIVE_PROVIDER_LOG, ${JSON.stringify(provider)} + ":" + process.argv.slice(2).join(" ") + "\\n");
`);
    chmodSync(providerBin, 0o755);
    const inputPath = join(fx.root, "ordinary-restore.json");
    writeFileSync(inputPath, `${JSON.stringify({
      action: "restore_v1",
      journalPath: fx.journalPath,
      lockPath: fx.lockPath,
      dispatcherSource: stableDispatcherSource,
      activeRuntime: fx.runtimePath,
      managedServiceChild: fx.managedServiceChildPath,
      managedServiceState: fx.managedServiceStatePath,
      v1Target,
      v2Target,
    }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types", operationalRunnerSource, "run", "--input", inputPath,
    ], {
      encoding: "utf8",
      env: {
        ...fx.env,
        [envName]: providerBin,
        NEGATIVE_PROVIDER_LOG: providerLog,
        POISON_INJECT_ACTION: probeAction,
        POISON_INJECT_PROVIDER_ENV: envName,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(providerLog, "utf8").trim()).toBe(`${provider}:${probeAction}`);
    expect(JSON.parse(readFileSync(fx.journalPath, "utf8"))).toMatchObject({
      phase: "compensated",
      poisonDetection: { provider, action: probeAction, count: 1 },
      lastProvenPhase: "compensation_normal_verified",
    });
    if (existsSync(fx.managedServiceStatePath)) {
      const service = JSON.parse(readFileSync(fx.managedServiceStatePath, "utf8")) as { managerPid: number };
      managedServicePids.add(service.managerPid);
    }
    expect(existsSync(fx.credentialLeakPath)).toBe(false);
  });

  it("RB-04 uses a real shared/exclusive flock boundary for normal worker dispatch", async () => {
    const fx = subprocessFixture();
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const current = JSON.parse(readFileSync(fx.journalPath, "utf8")) as Record<string, unknown>;
    current.phase = "committed";
    writeFileSync(fx.journalPath, `${JSON.stringify(current, null, 2)}\n`);
    const marker = join(fx.root, "exclusive-held");
    const holder = spawn("flock", [
      "-x", fx.lockPath, process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'held'); setTimeout(() => {}, 600)", marker,
    ], { stdio: "ignore" });
    await waitForFile(marker);
    const denied = fx.run(["worker"]);
    expect(denied.status).not.toBe(0);
    expect(`${denied.stderr}${denied.stdout}`).toMatch(/lock|busy|maintenance/i);
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.once("close", () => resolve());
    });
    const allowed = fx.run(["worker"]);
    expect(allowed.status).toBe(0);
    expect(readFileSync(fx.runtimeLogPath, "utf8")).toContain("worker");
    expect(readFileSync(fx.poisonPath, "utf8")).toBe("");
  });

  it("RB-15 denies normal worker and MCP subprocesses while journal phase is verifying", () => {
    const fx = subprocessFixture();
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    for (const args of [["worker"], ["mcp"]]) {
      const denied = fx.run(args, args[0] === "mcp"
        ? `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`
        : undefined);
      expect(denied.status).not.toBe(0);
      expect(`${denied.stderr}${denied.stdout}`).toMatch(/maintenance|verifying/i);
    }
    expect(existsSync(fx.runtimeLogPath)).toBe(false);
    expect(readFileSync(fx.poisonPath, "utf8")).toBe("");
  });

  it("RB-15 enforces durable action, nonce and one-shot replay permits for status and MCP", () => {
    const fx = subprocessFixture();
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const wrongNonce = fx.run([
      "status", "--action", "is_active", "--nonce", "wrong", "--permit", "status-token",
    ]);
    expect(wrongNonce.status).not.toBe(0);
    const wrongAction = fx.run([
      "mcp", "--action", "mcp_initialize", "--nonce", fx.nonce, "--permit", "status-token",
    ], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    expect(wrongAction.status).not.toBe(0);

    const allowedStatus = fx.run([
      "status", "--action", "is_active", "--nonce", fx.nonce, "--permit", "status-token",
    ]);
    expect(allowedStatus.status).toBe(0);
    expect(JSON.parse(allowedStatus.stdout)).toMatchObject({ protocol: "agent-collab/v1", targetVersion: "v1" });
    const replay = fx.run([
      "status", "--action", "is_active", "--nonce", fx.nonce, "--permit", "status-token",
    ]);
    expect(replay.status).not.toBe(0);
    expect(`${replay.stderr}${replay.stdout}`).toMatch(/replay|consumed/i);

    const allowedMcp = fx.run([
      "mcp", "--action", "mcp_initialize", "--nonce", fx.nonce, "--permit", "mcp-init-token",
    ], `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })}\n`);
    expect(allowedMcp.status).toBe(0);
    const durable = JSON.parse(readFileSync(fx.journalPath, "utf8")) as {
      permits: Record<string, { consumed: boolean }>;
    };
    expect(durable.permits.is_active?.consumed).toBe(true);
    expect(durable.permits.mcp_initialize?.consumed).toBe(true);
    expect(readFileSync(fx.poisonPath, "utf8")).toBe("");
  });

  it.each([
    ["committed_start_pending", "v1", "committed"],
    ["compensated_start_pending", "v2", "compensated"],
  ] as const)("RB-14 %s requires a one-shot start_normal permit and post-start proof", (phase, target, finalPhase) => {
    const fx = subprocessFixture(phase);
    expect(fx.targetVersion).toBe(target);
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const direct = fx.run(["worker"]);
    expect(direct.status).not.toBe(0);
    expect(existsSync(fx.databaseOpenPath)).toBe(false);
    for (const [nonce, action, token] of [
      ["wrong", "start_normal", "start-normal-token"],
      [fx.nonce, "prove_normal", "start-normal-token"],
    ] as const) {
      expect(fx.run([
        "start-normal", "--target", target, "--action", action,
        "--nonce", nonce, "--permit", token,
      ]).status).not.toBe(0);
    }
    const started = fx.run([
      "start-normal", "--target", target, "--action", "start_normal",
      "--nonce", fx.nonce, "--permit", "start-normal-token",
    ]);
    expect(started.status).toBe(0);
    expect((JSON.parse(readFileSync(fx.journalPath, "utf8")) as { phase: string }).phase)
      .toBe("normal_started_pending_proof");
    expect(fx.run([
      "start-normal", "--target", target, "--action", "start_normal",
      "--nonce", fx.nonce, "--permit", "start-normal-token",
    ]).status).not.toBe(0);
    expect((JSON.parse(readFileSync(fx.journalPath, "utf8")) as { phase: string }).phase)
      .not.toBe(finalPhase);
    const proven = fx.run([
      "prove-normal", "--target", target, "--action", "prove_normal",
      "--nonce", fx.nonce, "--permit", "prove-normal-token",
    ]);
    expect(proven.status).toBe(0);
    expect((JSON.parse(readFileSync(fx.journalPath, "utf8")) as { phase: string }).phase).toBe(finalPhase);
    expect(fx.run([
      "prove-normal", "--target", target, "--action", "prove_normal",
      "--nonce", fx.nonce, "--permit", "prove-normal-token",
    ]).status).not.toBe(0);
    expect(runtimeRecords(fx.runtimeLogPath).map((record) => record.argv[0])).toEqual(["worker", "status"]);
  });

  it.each(["v1", "v2"] as const)("RB-15 performs exact offline JSON-RPC verification for %s without poison providers", (target) => {
    const fx = subprocessFixture("verifying", target);
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const status = fx.run([
      "status", "--action", "is_active", "--nonce", fx.nonce, "--permit", "status-token",
    ]);
    expect(JSON.parse(status.stdout)).toMatchObject({ protocol: "agent-collab/v1", targetVersion: target });
    const verifyUnit = fx.run([
      "verify-unit", "--action", "start_verification", "--nonce", fx.nonce,
      "--permit", "verify-unit-token",
    ]);
    expect(verifyUnit.status).toBe(0);
    const initializeRequest = { jsonrpc: "2.0", id: 11, method: "initialize", params: {} };
    const toolsRequest = { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} };
    const session = fx.run([
      "mcp-verify-session", "--nonce", fx.nonce,
      "--initialize-action", "mcp_initialize", "--initialize-permit", "mcp-init-token",
      "--tools-action", "mcp_list_tools", "--tools-permit", "mcp-tools-token",
    ], `${JSON.stringify(initializeRequest)}\n${JSON.stringify(toolsRequest)}\n`);
    expect(session.status).toBe(0);
    const responses = session.stdout.trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(responses).toEqual([{
      jsonrpc: "2.0", id: 11,
      result: {
        protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "agent-collab", version: "v1" },
      },
    }, {
      jsonrpc: "2.0", id: 12,
      result: { tools: [{ name: "collab_status" }, { name: "collab_delegate" }] },
    }]);
    const deniedNormalMcp = fx.run(["mcp"], `${JSON.stringify(initializeRequest)}\n`);
    expect(deniedNormalMcp.status).not.toBe(0);
    expect(runtimeRecords(fx.runtimeLogPath).map((record) => record.argv)).toEqual([
      ["status"],
      ["verify-unit", "--nonce", fx.nonce],
      ["mcp"],
    ]);
    expect(readFileSync(fx.poisonPath, "utf8")).toBe("");
    expect(existsSync(fx.credentialLeakPath)).toBe(false);
  });

  it("RB-15 consumes one concurrent subprocess permit before runtime execution", async () => {
    const fx = subprocessFixture();
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const args = ["status", "--action", "is_active", "--nonce", fx.nonce, "--permit", "status-token"];
    const first = fx.spawnRun(args);
    const second = fx.spawnRun(args);
    const codes = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(codes.filter((code) => code === 0)).toHaveLength(1);
    expect(runtimeRecords(fx.runtimeLogPath)).toHaveLength(1);
    expect((JSON.parse(readFileSync(fx.journalPath, "utf8")) as {
      permits: Record<string, { consumed: boolean }>;
    }).permits.is_active?.consumed).toBe(true);
  });

  it.each([
    ["committed_start_pending", "v1"],
    ["compensated_start_pending", "v2"],
  ] as const)("RB-14 executes one normal %s runtime under a concurrent start_normal token race", async (phase, target) => {
    const fx = subprocessFixture(phase);
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const args = [
      "start-normal", "--target", target, "--action", "start_normal",
      "--nonce", fx.nonce, "--permit", "start-normal-token",
    ];
    const first = fx.spawnRun(args);
    const second = fx.spawnRun(args);
    const codes = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(codes.filter((code) => code === 0)).toHaveLength(1);
    expect(runtimeRecords(fx.runtimeLogPath).filter((record) => record.argv[0] === "worker")).toHaveLength(1);
    expect((JSON.parse(readFileSync(fx.journalPath, "utf8")) as { phase: string }).phase)
      .toBe("normal_started_pending_proof");
  });

  it.each([
    ["after_permit_consume", 0],
    ["after_runtime_exec", 1],
  ] as const)("RB-15 burns a permit after dispatcher crash at %s", (failpoint, runtimeExecutions) => {
    const fx = subprocessFixture();
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const args = ["status", "--action", "is_active", "--nonce", fx.nonce, "--permit", "status-token"];
    expect(fx.run(args, undefined, { AGENT_COLLAB_DISPATCHER_FAILPOINT: failpoint }).status).not.toBe(0);
    expect(runtimeRecords(fx.runtimeLogPath)).toHaveLength(runtimeExecutions);
    const replay = fx.run(args);
    expect(replay.status).not.toBe(0);
    expect(runtimeRecords(fx.runtimeLogPath)).toHaveLength(runtimeExecutions);
  });

  it.each([
    "preflight", "dispatcher_configured", "service_stopped", "legacy_terminated", "service_drained",
    "systemd_inactive", "fds_zero", "quiesced", "v1_revalidated", "targets_revalidated",
    "current_v2_backed_up", "staged", "pair_restore_started", "state_restored", "history_restored",
    "data_restored", "runtime_switched", "unit_installed", "daemon_reloaded", "mcp_patched",
    "verification_lock_acquired", "verifying", "verification_started", "active_verified", "pid_verified",
    "exec_start_verified", "mcp_initialized", "mcp_tools_verified", "physical_verified",
    "verification_stopped", "verification_drained", "verification_fds_zero", "poison_proven",
    "verification_lock_released", "commit_lock_acquired", "cleaned", "committed_start_pending",
    "normal_started", "normal_verified", "normal_started_pending_proof", "compensating",
    "compensation_quiesced", "compensation_mcp_patched", "compensation_verification_lock_acquired",
    "compensation_verification_started", "compensation_active_verified", "compensation_pid_verified",
    "compensation_exec_start_verified", "compensation_mcp_initialized", "compensation_physical_verified",
    "compensation_verification_stopped", "compensation_verification_drained",
    "compensation_verification_lock_released", "compensated_start_pending", "needs_reconciliation",
  ])("RB-04 denies normal dispatch before DB/WAL/SHM open in nonterminal phase %s", (phase) => {
    const fx = subprocessFixture();
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const durable = JSON.parse(readFileSync(fx.journalPath, "utf8")) as Record<string, unknown>;
    durable.phase = phase;
    writeFileSync(fx.journalPath, `${JSON.stringify(durable, null, 2)}\n`);
    expect(fx.run(["worker"]).status).not.toBe(0);
    expect(existsSync(fx.databaseOpenPath)).toBe(false);
  });

  it.each(["committed", "compensated"])("RB-04 permits normal dispatch only in terminal phase %s", (phase) => {
    const fx = subprocessFixture(phase as "committed" | "compensated");
    expect(fx.run(["worker"]).status).toBe(0);
    expect(runtimeRecords(fx.runtimeLogPath)).toHaveLength(1);
  });

  it("RB-04 fails closed on malformed journal and stale temporary journal", () => {
    const fx = subprocessFixture("committed");
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    writeFileSync(`${fx.journalPath}.tmp-stale`, JSON.stringify({ phase: "committed" }));
    writeFileSync(fx.journalPath, "{\"phase\":");
    expect(fx.run(["worker"]).status).not.toBe(0);
    expect(existsSync(fx.databaseOpenPath)).toBe(false);
    expect(existsSync(`${fx.journalPath}.tmp-stale`)).toBe(true);
  });

  it("RB-04 permits concurrent shared normal dispatch and rejects a reverse exclusive migration", async () => {
    const fx = subprocessFixture("committed");
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const simultaneousBarrier = join(fx.root, "shared-simultaneous.barrier");
    writeFileSync(simultaneousBarrier, "");
    const first = fx.spawnRun(["worker"], undefined, {
      RUNTIME_HOLD_MS: "300", RUNTIME_BARRIER_PATH: simultaneousBarrier,
    });
    const second = fx.spawnRun(["worker"], undefined, {
      RUNTIME_HOLD_MS: "300", RUNTIME_BARRIER_PATH: simultaneousBarrier,
    });
    await waitForFile(fx.databaseOpenPath);
    const migration = fx.run(["migration-lock", "--nonce", fx.nonce, "--hold-ms", "1"]);
    expect(migration.status).not.toBe(0);
    expect(await Promise.all([waitForExit(first), waitForExit(second)])).toEqual([0, 0]);
    expect(readFileSync(simultaneousBarrier, "utf8").trim().split("\n")).toHaveLength(2);
    expect(runtimeRecords(fx.runtimeLogPath)).toHaveLength(2);
  });

  it("RB-04 acquires shared flock before reading phase, closing the phase-read TOCTOU window", async () => {
    const fx = subprocessFixture("committed");
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const afterLock = join(fx.root, "after-shared-lock");
    const continueAfterMutation = join(fx.root, "continue-after-phase-mutation");
    const child = fx.spawnRun(["worker"], undefined, {
      AGENT_COLLAB_AFTER_LOCK_MARKER: afterLock,
      AGENT_COLLAB_AFTER_LOCK_RELEASE: continueAfterMutation,
    });
    await waitForFile(afterLock);
    const durable = JSON.parse(readFileSync(fx.journalPath, "utf8")) as Record<string, unknown>;
    durable.phase = "verifying";
    writeFileSync(fx.journalPath, `${JSON.stringify(durable, null, 2)}\n`);
    writeFileSync(continueAfterMutation, "continue\n");
    expect(await waitForExit(child)).not.toBe(0);
    expect(existsSync(fx.databaseOpenPath)).toBe(false);
  });

  it("RB-04 serializes two migration subprocesses and releases exclusive flock after SIGKILL", async () => {
    const fx = subprocessFixture("committed");
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const heldMarker = join(fx.root, "dispatcher-exclusive-held");
    const first = fx.spawnRun(
      ["migration-lock", "--nonce", fx.nonce, "--hold-ms", "5000"],
      undefined,
      { AGENT_COLLAB_LOCK_HELD_MARKER: heldMarker },
    );
    await waitForFile(heldMarker);
    expect(fx.run(["migration-lock", "--nonce", fx.nonce, "--hold-ms", "1"]).status).not.toBe(0);
    first.kill("SIGKILL");
    await waitForExit(first);
    expect(fx.run(["migration-lock", "--nonce", fx.nonce, "--hold-ms", "1"]).status).toBe(0);
  });

  it("RB-04 evaluates journal phase and flock in one atomic denied-before-open section", async () => {
    const fx = subprocessFixture("verifying");
    expect(existsSync(stableDispatcherSource), "stable dispatcher source must exist").toBe(true);
    const marker = join(fx.root, "external-exclusive-held");
    const holder = spawn("flock", [
      "-x", fx.lockPath, process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'held'); setTimeout(() => {}, 500)", marker,
    ], { stdio: "ignore" });
    await waitForFile(marker);
    const durable = JSON.parse(readFileSync(fx.journalPath, "utf8")) as Record<string, unknown>;
    durable.phase = "committed";
    writeFileSync(fx.journalPath, `${JSON.stringify(durable, null, 2)}\n`);
    expect(fx.run(["worker"]).status).not.toBe(0);
    expect(existsSync(fx.databaseOpenPath)).toBe(false);
    await waitForExit(holder);
    expect(fx.run(["worker"]).status).toBe(0);
    expect(runtimeRecords(fx.runtimeLogPath)).toHaveLength(1);
  });
});

describe("filesystem SQLite/WAL database-pair gate", () => {
  it.each(["stateDatabase", "historyDatabase"] as const)(
    "RB-08 rejects corrupted %s retained backup before changing active data or link",
    (corruptKey) => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    expect(existsSync(join(fx.currentV2Root, "collaboration.db-wal"))).toBe(true);
    expect(existsSync(join(fx.currentV2Root, "history.db-shm"))).toBe(true);
    const inputPath = join(fx.root, "backup-input.json");
    const backupJournalPath = join(fx.root, "durable-v2-backup.json");
    const restoreActionLogPath = join(fx.root, "restore-v2-actions.jsonl");
    const firstActiveMutationMarkerPath = join(fx.root, "first-active-data-or-link-mutation");
    writeFileSync(inputPath, `${JSON.stringify({
      ...fx.input, sourceRoot: fx.currentV2Root, backupRoot: join(fx.root, "v2-backup"),
      backupJournalPath,
    }, null, 2)}\n`);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "backup-v2",
      "--input", inputPath, "--failpoint", "after_backup_journal_fsync",
    ], { encoding: "utf8", timeout: 10_000 });
    expect(crashed.signal).toBe("SIGKILL");
    const evidence = JSON.parse(readFileSync(backupJournalPath, "utf8")) as {
      currentV2Backup: DurablePairBackupEvidence & {
        fsync: { stateFile: true; historyFile: true; directory: true; journal: true; journalDirectory: true };
      };
    };
    expect(evidence.currentV2Backup.wal).toEqual({
      checkpointed: true, sourceWalObserved: true, sourceShmObserved: true,
    });
    expect(fileSha256(evidence.currentV2Backup.stateDatabase.path))
      .toBe(evidence.currentV2Backup.stateDatabase.sha256);
    expect(fileSha256(evidence.currentV2Backup.historyDatabase.path))
      .toBe(evidence.currentV2Backup.historyDatabase.sha256);
    expect(evidence.currentV2Backup.fsync).toEqual({
      stateFile: true, historyFile: true, directory: true, journal: true, journalDirectory: true,
    });
    writeFileSync(evidence.currentV2Backup[corruptKey].path, "corrupted-retained-backup");
    const siblingKey = corruptKey === "stateDatabase" ? "historyDatabase" : "stateDatabase";

    for (const file of ["collaboration.db", "history.db"]) {
      rmSync(join(fx.currentV2Root, file), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-wal`), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-shm`), { force: true });
      createDatabase(join(fx.currentV2Root, file), `mutated-${file}`);
    }
    const activeBeforeRestore = { labels: fx.labels(), link: readlinkSync(fx.activeLink) };
    expect(activeBeforeRestore.labels).toEqual({
      state: "mutated-collaboration.db", history: "mutated-history.db",
    });
    const restored = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "restore-v2-from-journal",
      "--journal", backupJournalPath, "--active-link", fx.activeLink,
      "--action-log", restoreActionLogPath, "--mutation-marker", firstActiveMutationMarkerPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(restored.status).not.toBe(0);
    expect(existsSync(firstActiveMutationMarkerPath)).toBe(false);
    const restoreActions = readFileSync(restoreActionLogPath, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line) as { event: string });
    expect(restoreActions.map(({ event }) => event)).toEqual([
      "backup_integrity_check_started", "backup_integrity_check_failed",
    ]);
    expect(restoreActions.some(({ event }) => event === "active_data_or_link_mutation_started"))
      .toBe(false);
    expect({ labels: fx.labels(), link: readlinkSync(fx.activeLink) }).toEqual(activeBeforeRestore);
    expect(existsSync(evidence.currentV2Backup.stateDatabase.path)).toBe(true);
    expect(existsSync(evidence.currentV2Backup.historyDatabase.path)).toBe(true);
    expect(fileSha256(evidence.currentV2Backup[siblingKey].path))
      .toBe(evidence.currentV2Backup[siblingKey].sha256);
    expect(JSON.parse(readFileSync(backupJournalPath, "utf8"))).toMatchObject({
      phase: "needs_reconciliation",
      lastProvenPhase: "backup_journal_fsynced",
      failedBackup: corruptKey,
      operatorActions: [
        "inspect_backup_integrity", "retain_v1_and_v2_evidence", "recreate_v2_backup",
      ],
    });
  });

  it("RB-08 calibration writes the marker immediately before the first active mutation for an intact backup", () => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const inputPath = join(fx.root, "backup-calibration-input.json");
    const backupJournalPath = join(fx.root, "durable-v2-calibration-backup.json");
    const restoreActionLogPath = join(fx.root, "restore-v2-calibration-actions.jsonl");
    const firstActiveMutationMarkerPath = join(fx.root, "calibration-first-active-mutation");
    writeFileSync(inputPath, `${JSON.stringify({
      ...fx.input, sourceRoot: fx.currentV2Root, backupRoot: join(fx.root, "v2-calibration-backup"),
      backupJournalPath,
    }, null, 2)}\n`);
    const backedUp = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "backup-v2", "--input", inputPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(backedUp.status).toBe(0);
    const evidence = JSON.parse(readFileSync(backupJournalPath, "utf8")) as {
      currentV2Backup: DurablePairBackupEvidence;
    };
    expect(fileSha256(evidence.currentV2Backup.stateDatabase.path))
      .toBe(evidence.currentV2Backup.stateDatabase.sha256);
    expect(fileSha256(evidence.currentV2Backup.historyDatabase.path))
      .toBe(evidence.currentV2Backup.historyDatabase.sha256);

    for (const file of ["collaboration.db", "history.db"]) {
      rmSync(join(fx.currentV2Root, file), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-wal`), { force: true });
      rmSync(join(fx.currentV2Root, `${file}-shm`), { force: true });
      createDatabase(join(fx.currentV2Root, file), `calibration-mutated-${file}`);
    }
    const restored = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "restore-v2-from-journal",
      "--journal", backupJournalPath, "--active-link", fx.activeLink,
      "--action-log", restoreActionLogPath, "--mutation-marker", firstActiveMutationMarkerPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(restored.status).toBe(0);
    expect(existsSync(firstActiveMutationMarkerPath)).toBe(true);
    const restoreEvents = readFileSync(restoreActionLogPath, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => (JSON.parse(line) as { event: string }).event);
    expect(restoreEvents).toEqual([
      "backup_integrity_check_started",
      "backup_integrity_check_passed",
      "first_active_mutation_marker_written",
      "active_data_or_link_mutation_started",
      "restore_completed",
    ]);
    expect(restoreEvents.indexOf("first_active_mutation_marker_written") + 1)
      .toBe(restoreEvents.indexOf("active_data_or_link_mutation_started"));
    expect(fx.labels()).toEqual({ state: "v2-state", history: "v2-history" });
  });

  it.each([
    ["after_first_copy", "recover", { state: "v1-state-wal", history: "v1-history-wal" }],
    ["after_pair_staged", "abort", { state: "v2-state", history: "v2-history" }],
    ["after_link_swap", "recover", { state: "v1-state-wal", history: "v1-history-wal" }],
  ] as const)("RB-09 fresh child %s after SIGKILL %s keeps one visible pair", (failpoint, resolution, expected) => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const inputPath = join(fx.root, "pair-input.json");
    writeFileSync(inputPath, `${JSON.stringify(fx.input, null, 2)}\n`);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, "replace",
      "--input", inputPath, "--failpoint", failpoint,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(crashed.signal).toBe("SIGKILL");
    const visibleAfterCrash = fx.labels();
    expect(
      (visibleAfterCrash.state.startsWith("v1-") && visibleAfterCrash.history.startsWith("v1-")) ||
      (visibleAfterCrash.state.startsWith("v2-") && visibleAfterCrash.history.startsWith("v2-")),
    ).toBe(true);
    const fresh = spawnSync(process.execPath, [
      "--experimental-strip-types", databasePairModulePath, resolution, "--input", inputPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(fresh.status).toBe(0);
    expect(fx.labels()).toEqual(expected);
    expect(existsSync(fx.currentV2Root)).toBe(true);
    expect(existsSync(fx.targetV1Root)).toBe(true);
  });

  it("RB-09 never exposes a mixed active pair after the first replacement and recovers after restart", async () => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const firstProcess = await loadDatabasePairModule();
    await expect(firstProcess.replaceDatabasePairAtomically({
      ...fx.input, failpoint: "after_first_replacement",
    })).rejects.toThrow(/after_first_replacement|simulated crash/i);
    expect(fx.labels()).toEqual({ state: "v2-state", history: "v2-history" });
    expect(readlinkSync(fx.activeLink)).toBe(fx.currentV2Root);

    const restartedProcess = await loadDatabasePairModule();
    await restartedProcess.recoverDatabasePairReplacement(fx.input);
    expect(fx.labels()).toEqual({ state: "v1-state-wal", history: "v1-history-wal" });
    expect(readlinkSync(fx.activeLink)).not.toBe(fx.currentV2Root);
    expect(existsSync(fx.currentV2Root)).toBe(true);
    expect(existsSync(fx.targetV1Root)).toBe(true);
  });

  it("RB-09 aborts staged WAL recovery without mixed visibility and retains both evidence roots", async () => {
    const fx = sqlitePairFixture();
    expect(existsSync(databasePairModulePath), "database-pair implementation must exist").toBe(true);
    const module = await loadDatabasePairModule();
    await expect(module.replaceDatabasePairAtomically({
      ...fx.input, failpoint: "after_history_backup_before_link_swap",
    })).rejects.toThrow(/after_history_backup_before_link_swap|simulated crash/i);
    await module.abortDatabasePairReplacement(fx.input);
    expect(fx.labels()).toEqual({ state: "v2-state", history: "v2-history" });
    expect(lstatSync(fx.activeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fx.activeLink)).toBe(fx.currentV2Root);
    expect(existsSync(fx.currentV2Root)).toBe(true);
    expect(existsSync(fx.targetV1Root)).toBe(true);
    expect(existsSync(fx.stagingRoot)).toBe(false);
  });
});

describe("atomic journal writer fresh-process gate", () => {
  it.each([
    ["after_temp_write", 1],
    ["after_file_fsync", 1],
    ["after_rename", 1],
    ["after_directory_fsync", 2],
    ["after_previous_rotation", 2],
  ] as const)("RB-14 SIGKILL %s recovers generation %i", (failpoint, recoveredGeneration) => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-journal-writer-"));
    roots.push(root);
    const journalPath = join(root, "restore-journal.json");
    const payloadPath = join(root, "next.json");
    writeFileSync(journalPath, `${JSON.stringify({ generation: 1, phase: "preflight", directoryFsynced: true })}\n`);
    writeFileSync(`${journalPath}.previous`, `${JSON.stringify({
      generation: 0, phase: "idle", directoryFsynced: true,
    })}\n`);
    writeFileSync(payloadPath, `${JSON.stringify({ generation: 2, phase: "data_restored" })}\n`);
    expect(existsSync(journalWriterSource), "atomic journal writer source must exist").toBe(true);
    const crashed = spawnSync(process.execPath, [
      "--experimental-strip-types", journalWriterSource, "write",
      "--journal", journalPath, "--payload", payloadPath, "--failpoint", failpoint,
    ], { encoding: "utf8", timeout: 5_000 });
    expect(crashed.signal).toBe("SIGKILL");
    const recovered = spawnSync(process.execPath, [
      "--experimental-strip-types", journalWriterSource, "recover", "--journal", journalPath,
    ], { encoding: "utf8", timeout: 5_000 });
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      generation: recoveredGeneration,
      source: recoveredGeneration === 2 ? "canonical" : "previous",
      integrity: "fsynced",
    });
    const durable = JSON.parse(readFileSync(journalPath, "utf8")) as {
      generation: number; directoryFsynced: boolean;
    };
    expect(durable).toMatchObject({ generation: recoveredGeneration, directoryFsynced: true });
    expect(existsSync(`${journalPath}.tmp`)).toBe(false);
  });
});

describe("legacy process bootstrap gate", () => {
  it.each([
    "collaboration.db", "collaboration.db-wal", "collaboration.db-shm",
    "history.db", "history.db-wal", "history.db-shm",
  ])("RB-08 switches config, terminates the legacy PID, and blocks on leftover %s fd", async (leftoverFile) => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-legacy-bootstrap-"));
    roots.push(root);
    const files = [
      "collaboration.db", "collaboration.db-wal", "collaboration.db-shm",
      "history.db", "history.db-wal", "history.db-shm",
    ].map((name) => join(root, name));
    for (const path of files) writeFileSync(path, "fd-proof");
    const holderPath = join(root, "fd-holder.mjs");
    writeFileSync(holderPath, `
import { openSync, writeFileSync } from "node:fs";
const [marker, ...paths] = process.argv.slice(2);
const fds = paths.map((path) => openSync(path, "r"));
writeFileSync(marker, JSON.stringify({ pid: process.pid, fds }) + "\\n");
setInterval(() => {}, 1000);
`);
    const legacyMarker = join(root, "legacy.json");
    const leftoverMarker = join(root, "leftover.json");
    const legacy = spawn(process.execPath, [holderPath, legacyMarker, ...files], { stdio: "ignore" });
    const leftover = spawn(process.execPath, [holderPath, leftoverMarker, join(root, leftoverFile)], { stdio: "ignore" });
    await Promise.all([waitForFile(legacyMarker), waitForFile(leftoverMarker)]);
    if (legacy.pid) managedServicePids.add(legacy.pid);
    if (leftover.pid) managedServicePids.add(leftover.pid);

    const codexConfig = join(root, "codex-config.toml");
    const grokConfig = join(root, "grok-config.json");
    writeFileSync(codexConfig, "codex-before\nagent-collab=direct-v2\ncodex-after\n");
    writeFileSync(grokConfig, "grok-before\nagent-collab=direct-v2\ngrok-after\n");
    const actionLog = join(root, "bootstrap-actions.jsonl");
    const mutationMarker = join(root, "first-db-mutation");
    const inputPath = join(root, "bootstrap.json");
    const stableMcp = `${process.execPath} ${stableDispatcherSource} mcp`;
    writeFileSync(inputPath, `${JSON.stringify({
      configs: [
        { path: codexConfig, exactBefore: "agent-collab=direct-v2", exactAfter: `agent-collab=${stableMcp}` },
        { path: grokConfig, exactBefore: "agent-collab=direct-v2", exactAfter: `agent-collab=${stableMcp}` },
      ],
      legacyPids: [legacy.pid],
      databaseFiles: files,
      actionLog,
      mutationMarker,
    }, null, 2)}\n`);
    expect(existsSync(operationalHostSource), "operational host source must exist").toBe(true);
    const blocked = spawnSync(process.execPath, [
      "--experimental-strip-types", operationalHostSource, "bootstrap", "--input", inputPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(blocked.status).not.toBe(0);
    if (legacy.exitCode === null) await waitForExit(legacy);
    expect(readFileSync(codexConfig, "utf8")).toBe(`codex-before\nagent-collab=${stableMcp}\ncodex-after\n`);
    expect(readFileSync(grokConfig, "utf8")).toBe(`grok-before\nagent-collab=${stableMcp}\ngrok-after\n`);
    expect(() => process.kill(legacy.pid!, 0)).toThrow();
    expect(() => process.kill(leftover.pid!, 0)).not.toThrow();
    expect(existsSync(mutationMarker)).toBe(false);
    const actions = readFileSync(actionLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      action: string; configBytes?: Record<string, string>; pid?: number;
    });
    expect(actions.map((entry) => entry.action)).toEqual([
      "dispatcher_config_switched", "legacy_pid_terminated", "systemd_inactive", "pid_fd_scan_blocked",
    ]);
    expect(actions[0]?.configBytes).toEqual({
      [codexConfig]: readFileSync(codexConfig, "utf8"),
      [grokConfig]: readFileSync(grokConfig, "utf8"),
    });

    leftover.kill("SIGKILL");
    await waitForExit(leftover);
    const continued = spawnSync(process.execPath, [
      "--experimental-strip-types", operationalHostSource, "bootstrap", "--input", inputPath,
    ], { encoding: "utf8", timeout: 10_000 });
    expect(continued.status).toBe(0);
    expect(readFileSync(mutationMarker, "utf8")).toBe("mutation-authorized-after-zero-fds\n");
  });
});

describe("operational v2 to v1 restore", () => {
  it("RB-04 binds one preflight to one restore nonce and excludes concurrent normal work", async () => {
    const { host, journalPath, restore } = fixture();
    const attempts = await Promise.allSettled([
      restore.preflight({ action: "restore_v1" }), restore.preflight({ action: "restore_v1" }),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const receipt = attempts.find((item) => item.status === "fulfilled")!.value;
    expect(journal(journalPath)).toMatchObject({ action: "restore_v1", nonce: receipt.nonce, phase: "preflight" });
    expect(() => host.runNormalCommand()).toThrow(/maintenance/i);
    expect(host.actions).not.toContain("stop:v2");
  });

  it("RB-04 denies normal commands from the durable journal even if process-local guards are lost", async () => {
    const { host, restore } = fixture(); await restore.preflight({ action: "restore_v1" });
    host.maintenance = false; host.dispatcherLock = undefined;
    expect(() => host.runNormalCommand()).toThrow(/maintenance/i);
  });

  it.each([
    ["path", (target: OperationalTarget) => { target.dispatcher.path = "/other/dispatcher.js"; }],
    ["sha", (target: OperationalTarget) => { target.dispatcher.sha256 = digest("0"); }],
    ["MCP tuple", (target: OperationalTarget) => { target.dispatcher.mcpRegistration = "node other.js mcp"; }],
  ] as const)("RB-04 rejects dispatcher %s mismatch before maintenance", async (_name, mutate) => {
    const badV1 = structuredClone(v1Target); mutate(badV1);
    const { host, journalPath, restore } = fixture({ v1: badV1 });
    await expect(restore.preflight({ action: "restore_v1" })).rejects.toThrow(/dispatcher/i);
    expect(host.actions).toEqual([]);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("RB-08..12 restores the DB pair, runtime, unit, dispatcher MCP and service in strict order", async () => {
    const { host, journalPath, restore } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    expect(host.actions).toEqual([
      "maintenance:on", "lock:exclusive", "verify_target:v1", "verify_target:v2",
    ]);
    await expect(restore.restore(receipt)).resolves.toMatchObject({ phase: "committed" });
    const poisonBegin = host.actions.indexOf("poison:begin:v1:claude,codex,grok");
    const dispatcherSwitch = host.actions.indexOf("dispatcher_config:v1");
    expect(poisonBegin).toBeLessThan(dispatcherSwitch);
    expect(host.actions.slice(dispatcherSwitch)).toEqual(successOrder);
    expect(host.physical).toMatchObject({
      stateDatabase: v1Target.stateDatabase.sha256,
      historyDatabase: v1Target.historyDatabase.sha256,
      runtimeSymlink: v1Target.runtime.path,
      unitDigest: v1Target.unit.sha256,
      dispatcherDigest: dispatcher.sha256,
      service: { active: true, pid: 1001, execStart: `${dispatcher.path} worker` },
      openDatabaseFds: 0,
    });
    expect(journal(journalPath).phase).toBe("committed");
  });

  it("RB-08 switches every entrypoint to the dispatcher before legacy shutdown and proves DB/WAL/SHM closed before mutation", async () => {
    const { host, restore } = fixture();
    await restore.restore(await restore.preflight({ action: "restore_v1" }));
    const firstMutation = host.actions.indexOf("stage:v1");
    const requiredBootstrap = [
      "dispatcher_config:v1", "stop:v2", "terminate_legacy:v2", "drain:v2",
      "systemd_inactive:v2", "fds_zero:v2", "scan_processes:v2:pid,db,wal,shm",
    ];
    expect(host.actions.slice(host.actions.indexOf("dispatcher_config:v1"), firstMutation))
      .toEqual(expect.arrayContaining(requiredBootstrap));
    for (let index = 1; index < requiredBootstrap.length; index += 1) {
      expect(host.actions.indexOf(requiredBootstrap[index - 1]!))
        .toBeLessThan(host.actions.indexOf(requiredBootstrap[index]!));
    }
    expect(host.actions.indexOf("scan_processes:v2:pid,db,wal,shm")).toBeLessThan(firstMutation);
  });

  it("RB-12 cleanup removes only staged scratch and retains both immutable runtime roots and bundles", async () => {
    const { host, restore } = fixture();
    await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(host.actions).toContain("stage:v1");
    expect(host.actions).toContain("cleanup:v1");
    expect(host.stagedArtifacts).toEqual(new Set());
    expect(host.retainedBundles).toEqual(new Set([v1Target.bundle.path, v2Target.bundle.path]));
    expect(host.retainedRoots).toEqual(new Set([v1Target.runtime.path, v2Target.runtime.path]));
  });

  it.each(v1PhysicalBoundaries.flatMap(([action, phase, occurrence]) => [
    ["before", action, phase, occurrence],
    ["after", action, phase, occurrence],
  ] as const))(
    "RB-14 reconstructs from durable files after %s-effect crash at %s",
    async (side, action, durablePhase, occurrence) => {
      const { host, journalPath, restore, recreate } = fixture();
      const receipt = await restore.preflight({ action: "restore_v1" });
      if (side === "before") host.crashOn(action, occurrence);
      else host.crashAfter(action, occurrence);
      await expect(restore.restore(receipt)).rejects.toThrow(/simulated process crash/i);
      expect(journal(journalPath).phase).toBe(durablePhase);
      const reconstructed = recreate();
      expect(reconstructed.host).not.toBe(host);
      const result = await reconstructed.restore.recover();
      expect(result.phase).toBe("committed");
      const pair = [
        reconstructed.host.physical.stateDatabase,
        reconstructed.host.physical.historyDatabase,
      ];
      expect(pair).toEqual([v1Target.stateDatabase.sha256, v1Target.historyDatabase.sha256]);
      expect(reconstructed.host.pendingDatabasePair).toBeUndefined();
    },
  );

  it("RB-14 recovers a truncated canonical journal from its last fsynced previous image and fails closed", async () => {
    const { journalPath, restore, recreate } = fixture();
    await restore.preflight({ action: "restore_v1" });
    writeFileSync(`${journalPath}.previous`, readFileSync(journalPath));
    writeFileSync(journalPath, "{\"phase\":\"data_restored\"");
    const reconstructed = recreate();
    const result = await reconstructed.restore.recover();
    expect(result.phase).toBe("needs_reconciliation");
    expect(journal(journalPath)).toMatchObject({
      lastProvenPhase: "preflight",
      operatorActions: expect.arrayContaining(["inspect_journal_integrity", "retain_v1_and_v2_evidence"]),
    });
    expect(reconstructed.host.physical.service.active).toBe(false);
  });

  it("RB-14 ignores a stale temporary journal and resumes only from the canonical fsynced image", async () => {
    const { journalPath, restore, recreate } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    writeFileSync(`${journalPath}.tmp-stale`, `${JSON.stringify({
      ...journal(journalPath), nonce: "attacker", phase: "committed",
    })}\n`);
    expect((await recreate().restore.recover()).phase).toBe("committed");
    expect(journal(journalPath).nonce).toBe(receipt.nonce);
    expect(existsSync(`${journalPath}.tmp-stale`)).toBe(false);
  });

  it("RB-14 treats rename-before-directory-fsync as uncommitted journal state", async () => {
    const { journalPath, restore, recreate } = fixture();
    await restore.preflight({ action: "restore_v1" });
    const durable = journal(journalPath) as ReturnType<typeof journal> & {
      journalWrite?: { renamed: boolean; directoryFsynced: boolean };
    };
    durable.phase = "data_restored";
    durable.journalWrite = { renamed: true, directoryFsynced: false };
    const renamed = `${journalPath}.renamed-not-fsynced`;
    writeFileSync(renamed, `${JSON.stringify(durable, null, 2)}\n`);
    renameSync(renamed, journalPath);
    expect((await recreate().restore.recover()).phase).toBe("needs_reconciliation");
    expect(journal(journalPath).lastProvenPhase).toBe("preflight");
  });

  it("RB-08 revalidates both immutable targets after quiescence and captures a WAL-safe current-v2 pair before mutation", async () => {
    const { host, journalPath, restore } = fixture();
    await restore.restore(await restore.preflight({ action: "restore_v1" }));
    const all = host.actions;
    const secondV1Verification = all.lastIndexOf("verify_target:v1");
    const secondV2Verification = all.lastIndexOf("verify_target:v2");
    expect(all.filter((action) => action === "verify_target:v1")).toHaveLength(2);
    expect(all.filter((action) => action === "verify_target:v2")).toHaveLength(2);
    expect(all.indexOf("fds_zero:v2")).toBeLessThan(secondV1Verification);
    expect(secondV1Verification).toBeLessThan(secondV2Verification);
    expect(secondV2Verification).toBeLessThan(all.indexOf("backup_pair:v2"));
    expect(all.indexOf("backup_pair:v2")).toBeLessThan(all.indexOf("stage:v1"));
    expect(host.walSafeBackups[0]).toEqual({
      version: "v2",
      state: v2Target.stateDatabase.sha256,
      history: v2Target.historyDatabase.sha256,
    });
    expect(journal(journalPath).currentV2Backup).toEqual({
      version: "v2",
      stateDatabase: {
        path: "/durable-backup/v2/collaboration.db",
        sha256: v2Target.stateDatabase.sha256,
      },
      historyDatabase: {
        path: "/durable-backup/v2/history.db",
        sha256: v2Target.historyDatabase.sha256,
      },
      wal: { checkpointed: true, sourceWalObserved: true, sourceShmObserved: true },
    });
  });

  it("RB-09 journals each completed physical boundary before the next one", async () => {
    const { host, restore } = fixture();
    await restore.restore(await restore.preflight({ action: "restore_v1" }));
    const expected = [
      ["dispatcher_config:v1", "preflight"],
      ["stop:v2", "dispatcher_configured"],
      ["terminate_legacy:v2", "service_stopped"],
      ["drain:v2", "legacy_terminated"],
      ["systemd_inactive:v2", "service_drained"],
      ["fds_zero:v2", "systemd_inactive"],
      ["scan_processes:v2:pid,db,wal,shm", "fds_zero"],
      ["verify_target:v1", "quiesced", 2],
      ["verify_target:v2", "v1_revalidated", 2],
      ["backup_pair:v2", "targets_revalidated"],
      ["stage:v1", "current_v2_backed_up"],
      ["db_pair:begin:v1", "staged"],
      ["restore_state:v1", "pair_restore_started"],
      ["restore_history:v1", "state_restored"],
      ["db_pair:commit:v1", "history_restored"],
      ["runtime:v1", "data_restored"],
      ["unit:v1", "runtime_switched"],
      ["daemon_reload", "unit_installed"],
      ["mcp:v1", "daemon_reloaded"],
      ["verify_lock:acquire", "mcp_patched"],
      ["lock:release", "verification_lock_acquired", 1],
      ["start_verification:v1", "verifying"],
      ["is_active:v1", "verification_started"],
      ["pid:v1", "active_verified"],
      ["exec_start:v1", "pid_verified"],
      ["mcp_initialize:v1", "exec_start_verified"],
      ["mcp_list_tools:v1", "mcp_initialized"],
      ["verify_physical:v1", "mcp_tools_verified"],
      ["stop_verification:v1", "physical_verified"],
      ["drain_verification:v1", "verification_stopped"],
      ["fds_zero:v1", "verification_drained"],
      ["poison:end:v1", "verification_fds_zero"],
      ["verify_lock:release", "poison_proven"],
      ["lock:exclusive", "verification_lock_released", 2],
      ["cleanup:v1", "commit_lock_acquired"],
      ["commit:v1", "cleaned"],
      ["lock:release", "committed_start_pending", 2],
      ["maintenance:off", "committed_start_pending"],
      ["start:v1", "committed_start_pending"],
      ["verify_normal:v1", "normal_started"],
      ["handoff_restart:v1", "normal_verified"],
    ] as const;
    for (const [action, phase, wantedOccurrence = 1] of expected) {
      const matches = host.phaseBeforeAction.filter((entry) => entry.action === action);
      expect(matches[wantedOccurrence - 1], `${action} occurrence ${wantedOccurrence}`).toEqual({ action, phase });
    }
  });

  it("RB-10 preserves unrelated MCP bytes and uses the stable dispatcher for both clients", async () => {
    const { host, restore } = fixture();
    await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(host.mcp).toEqual({
      codex: `codex-before\nagent-collab=${dispatcher.mcpRegistration}\ncodex-after\n`,
      grok: `grok-before\nagent-collab=${dispatcher.mcpRegistration}\ngrok-after\n`,
    });
    expect(v1Target.dispatcher).toEqual(v2Target.dispatcher);
  });

  it("RB-11 persists consumed restore and verification permits across reconstruction", async () => {
    const { host, journalPath, restore, recreate } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    const first = await restore.restore(receipt);
    const actions = [...host.actions];
    expect(await restore.recover()).toEqual(first);
    const durable = journal(journalPath);
    expect(durable.restoreNonceConsumed).toBe(true);
    expect(Object.keys(durable.permits).sort()).toEqual(["exec_start", "is_active", "mcp_initialize", "mcp_list_tools", "pid"]);
    expect(Object.values(durable.permits).every((permit) => permit.nonce === receipt.nonce && permit.consumed)).toBe(true);
    const reconstructed = recreate();
    expect(await reconstructed.restore.recover()).toEqual(first);
    expect(reconstructed.host.actions).toEqual([]);
    expect(host.actions).toEqual(actions);
  });

  it("RB-11 rejects a wrong restore nonce", async () => {
    const { restore } = fixture(); const receipt = await restore.preflight({ action: "restore_v1" });
    await expect(restore.restore({ ...receipt, nonce: "wrong" })).rejects.toThrow(/nonce/i);
  });

  it("RB-11 rejects a nonce bound to the wrong action", async () => {
    const { restore } = fixture(); const receipt = await restore.preflight({ action: "restore_v1" });
    await expect(restore.restore({ action: "compensate_v2", nonce: receipt.nonce } as unknown as typeof receipt))
      .rejects.toThrow(/action/i);
  });

  it("RB-11 rejects replay after recreating the state machine", async () => {
    const { restore, recreate } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" }); await restore.restore(receipt);
    await expect(recreate().restore.restore(receipt)).rejects.toThrow(/replay|consumed/i);
  });

  it("RB-12 snapshots all target paths, digests, prior service state and provider poison set", async () => {
    const mutableV1 = structuredClone(v1Target);
    const mutableV2 = structuredClone(v2Target);
    const { journalPath, restore } = fixture({ v1: mutableV1, v2: mutableV2 });
    mutableV1.stateDatabase.sha256 = digest("9");
    mutableV1.runtime.path = "/attacker";
    mutableV2.serviceWasActive = false;
    mutableV2.poisonProviders.push("attacker");
    await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(journal(journalPath)).toMatchObject({ v1Target, v2Target });
  });

  it.each<FaultAction>([
    "dispatcher_config:v1", "stop:v2", "terminate_legacy:v2", "drain:v2", "systemd_inactive:v2",
    "fds_zero:v2", "scan_processes:v2:pid,db,wal,shm", "backup_pair:v2", "stage:v1", "db_pair:begin:v1",
    "restore_state:v1", "restore_history:v1", "db_pair:commit:v1", "runtime:v1", "unit:v1",
    "daemon_reload", "mcp:v1",
    "start_verification:v1", "start:v1", "is_active:v1", "pid:v1", "exec_start:v1", "mcp_initialize:v1",
    "mcp_list_tools:v1", "verify_physical:v1", "poison:end:v1", "verify_lock:release", "cleanup:v1",
    "commit:v1", "verify_normal:v1", "handoff_restart:v1",
  ])("RB-13 returns to the exact verified v2 state and commits compensated after %s", async (fault) => {
    const { host, journalPath, restore } = fixture();
    host.failQueue.push(fault);
    const result = await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(result.phase).toBe("compensated");
    expect(journal(journalPath).phase).toBe("compensated");
    expect(host.phaseBeforeAction).toContainEqual({ action: "stop:v1", phase: "compensating" });
    expect(host.physical).toMatchObject({
      stateDatabase: v2Target.stateDatabase.sha256,
      historyDatabase: v2Target.historyDatabase.sha256,
      runtimeSymlink: v2Target.runtime.path,
      unitDigest: v2Target.unit.sha256,
      dispatcherDigest: v2Target.dispatcher.sha256,
      service: { active: true, execStart: `${dispatcher.path} worker` },
    });
    if (fault === "unit:v1") {
      expect(host.actions.slice(host.actions.indexOf("poison:begin:v2:claude,codex,grok"))).toEqual(compensationOrder);
    }
  });

  it.each([
    ["post-quiescence v1 revalidation", "verify_target:v1", 2],
    ["post-quiescence v2 revalidation", "verify_target:v2", 2],
    ["exclusive commit-lock reacquisition", "lock:exclusive", 2],
    ["post-commit lock release", "lock:release", 2],
    ["maintenance exit", "maintenance:off", 1],
  ] as const)("RB-13 compensates after %s failure", async (_case, action, occurrence) => {
    const { host, restore } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    host.failOn(action, occurrence);
    const result = await restore.restore(receipt);
    expect(result.phase).toBe("compensated");
    expect(host.physical.stateDatabase).toBe(v2Target.stateDatabase.sha256);
    expect(host.physical.historyDatabase).toBe(v2Target.historyDatabase.sha256);
  });

  it("RB-13 aborts a partial compensation pair when v2 state staging succeeds but history staging fails", async () => {
    const { host, journalPath, restore } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    host.failQueue.push("unit:v1", "restore_history:v2");
    await expect(restore.restore(receipt)).rejects.toThrow(/compensation|reconciliation/i);
    expect(host.actions).toContain("db_pair:abort:v2");
    expect(host.pendingDatabasePair).toBeUndefined();
    const pair = [host.physical.stateDatabase, host.physical.historyDatabase];
    expect(pair).toEqual([v1Target.stateDatabase.sha256, v1Target.historyDatabase.sha256]);
    expect(journal(journalPath)).toMatchObject({
      phase: "needs_reconciliation",
      lastProvenPhase: expect.stringMatching(/data_restored|compensating/),
    });
  });

  it("RB-13 preserves an inactive prior v2 service during compensation", async () => {
    const inactiveV2 = { ...v2Target, serviceWasActive: false };
    const { host, restore } = fixture({ v2: inactiveV2 });
    host.physical.service = { active: false, execStart: `${dispatcher.path} worker` };
    host.failQueue.push("unit:v1");
    expect((await restore.restore(await restore.preflight({ action: "restore_v1" }))).phase).toBe("compensated");
    expect(host.physical.service.active).toBe(false);
    expect(host.actions).not.toContain("start:v2");
  });

  it("RB-13 compensates from the durable WAL-safe v2 backup evidence captured in the journal", async () => {
    const { host, journalPath, restore } = fixture();
    host.failQueue.push("unit:v1");
    expect((await restore.restore(await restore.preflight({ action: "restore_v1" }))).phase).toBe("compensated");
    expect(host.actions).toContain("restore_backup_pair:v2");
    expect(host.restoredBackupEvidence).toEqual(journal(journalPath).currentV2Backup);
    expect(host.restoredBackupEvidence).toMatchObject({
      stateDatabase: { path: "/durable-backup/v2/collaboration.db", sha256: v2Target.stateDatabase.sha256 },
      historyDatabase: { path: "/durable-backup/v2/history.db", sha256: v2Target.historyDatabase.sha256 },
      wal: { checkpointed: true, sourceWalObserved: true, sourceShmObserved: true },
    });
  });

  it("RB-15 releases dispatcher lock for isolated verification and reacquires it before commit", async () => {
    const { host, restore } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    expect(host.dispatcherLock).toBe("exclusive");
    expect(() => host.runNormalCommand()).toThrow(/maintenance/i);
    await restore.restore(receipt);
    expect(host.actions.indexOf("lock:release")).toBeLessThan(host.actions.indexOf("start_verification:v1"));
    expect(host.actions.indexOf("stop_verification:v1")).toBeLessThan(host.actions.lastIndexOf("lock:exclusive"));
    expect(host.actions.lastIndexOf("lock:exclusive")).toBeLessThan(host.actions.indexOf("commit:v1"));
    expect(host.normalCommandDeniedDuringVerification).toBe(true);
    expect(host.verificationLock).toBe(false);
    expect(host.dispatcherLock).toBeUndefined();
    expect(() => host.runNormalCommand()).not.toThrow();
  });

  it.each([
    "start_verification:v1", "is_active:v1", "pid:v1", "exec_start:v1",
    "mcp_initialize:v1", "mcp_list_tools:v1",
  ])("RB-16 rejects poison-provider activity at %s across the full verification span", async (poisonOn) => {
    const { host, journalPath, restore } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    host.poisonOn = poisonOn;
    const result = await restore.restore(receipt);
    expect(result.phase).toBe("compensated");
    expect(journal(journalPath).phase).toBe("compensated");
    expect(host.actions.indexOf("poison:begin:v1:claude,codex,grok")).toBeLessThan(host.actions.indexOf("stop:v2"));
    expect(host.actions.indexOf("poison:end:v1")).toBeGreaterThan(host.actions.indexOf("mcp_list_tools:v1"));
  });

  it.each([
    ["inactive unit", (host: FakeHost) => { host.verificationServiceOverrides.v1.active = false; }],
    ["undefined PID", (host: FakeHost) => { host.verificationServiceOverrides.v1.pid = null; }],
    ["stale PID", (host: FakeHost) => { host.verificationServiceOverrides.v1.pid = 2002; }],
    ["wrong ExecStart", (host: FakeHost) => {
      host.verificationServiceOverrides.v1.execStart = `${v1Target.runtime.path}/dist/cli.js worker`;
    }],
    ["missing MCP tools", (host: FakeHost) => { host.verificationServiceOverrides.v1.tools = []; }],
    ["wrong MCP tools", (host: FakeHost) => {
      host.verificationServiceOverrides.v1.tools = ["collab_status", "unexpected_tool"];
    }],
    ["wrong target version", (host: FakeHost) => { host.verificationOverrides.v1.targetVersion = "v2"; }],
  ] as const)("RB-16 compensates when isolated verification reports %s", async (_case, arrange) => {
    const { host, restore } = fixture();
    arrange(host);
    const result = await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(result.phase).toBe("compensated");
    expect(host.actions).not.toContain("commit:v1");
    expect(host.physical).toMatchObject({
      stateDatabase: v2Target.stateDatabase.sha256,
      historyDatabase: v2Target.historyDatabase.sha256,
      runtimeSymlink: v2Target.runtime.path,
      service: { active: true, execStart: `${dispatcher.path} worker` },
    });
  });

  it.each([
    ["inactive", { terminal: true, success: false }],
    ["nonterminal", { terminal: false, success: false }],
    ["wrong target", { terminal: true, success: true, targetVersion: "v2" as const }],
  ] as const)("RB-17 does not finalize after post-start normal-service proof is %s", async (_case, override) => {
    const { host, journalPath, restore } = fixture();
    host.normalVerificationOverrides.v1 = override;
    const result = await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(result.phase).not.toBe("committed");
    expect(journal(journalPath).phase).not.toBe("committed");
    expect(host.actions).toContain("verify_normal:v1");
  });

  it("RB-17 records restart-required handoff only after a proven normal v1 start", async () => {
    const { host, journalPath, restore } = fixture();
    const result = await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(result.phase).toBe("committed");
    expect(host.actions.indexOf("verify_normal:v1")).toBeLessThan(host.actions.indexOf("handoff_restart:v1"));
    expect(journal(journalPath).restartRequiredClients).toEqual(["codex", "grok"]);
  });

  it.each([
    ["state staged before history", "restore_history:v1", "state_restored"],
    ["both databases replaced before runtime", "runtime:v1", "data_restored"],
    ["runtime switched before unit and MCP", "unit:v1", "runtime_switched"],
    ["verification unit started", "is_active:v1", "verification_started"],
    ["exclusive lock reacquired before cleanup", "cleanup:v1", "commit_lock_acquired"],
  ] as const)("RB-14 resumes safely after crash with %s", async (_case, crashAction, durablePhase) => {
    const { host, journalPath, restore, recreate } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    host.crashOn(crashAction);
    await expect(restore.restore(receipt)).rejects.toThrow(/simulated process crash/i);
    expect(journal(journalPath).phase).toBe(durablePhase);
    const reconstructed = recreate();
    const result = await reconstructed.restore.recover();
    expect(result.phase).toBe("committed");
    expect(reconstructed.host.successfulStarts.filter((version) => version === "v1")).toHaveLength(1);
    expect(reconstructed.host.physical).toMatchObject({
      stateDatabase: v1Target.stateDatabase.sha256,
      historyDatabase: v1Target.historyDatabase.sha256,
      runtimeSymlink: v1Target.runtime.path,
      service: { active: true, execStart: `${dispatcher.path} worker` },
    });
  });

  it("RB-14 recovers committed_start_pending by revalidating v1 and starting normal service exactly once", async () => {
    const { host, journalPath, restore, recreate } = fixture();
    const receipt = await restore.preflight({ action: "restore_v1" });
    host.crashOn("start:v1");
    await expect(restore.restore(receipt)).rejects.toThrow(/simulated process crash/i);
    expect(journal(journalPath).phase).toBe("committed_start_pending");
    expect(host.physical.service.active).toBe(false);
    const reconstructed = recreate();
    expect((await reconstructed.restore.recover()).phase).toBe("committed");
    expect(reconstructed.host.successfulStarts.filter((version) => version === "v1")).toHaveLength(1);
    const recoveryStart = reconstructed.host.actions.lastIndexOf("start:v1");
    expect(reconstructed.host.actions.lastIndexOf("verify_target:v1")).toBeLessThan(recoveryStart);
    expect(reconstructed.host.actions.lastIndexOf("verify_normal:v1")).toBeGreaterThan(recoveryStart);
  });

  it("RB-14 recovers compensated_start_pending by revalidating v2 and starting it exactly once", async () => {
    const { host, journalPath, restore, recreate } = fixture();
    host.failQueue.push("unit:v1");
    host.crashOn("start:v2");
    await expect(restore.restore(await restore.preflight({ action: "restore_v1" })))
      .rejects.toThrow(/simulated process crash/i);
    expect(journal(journalPath).phase).toBe("compensated_start_pending");
    expect(host.physical.service.active).toBe(false);
    const reconstructed = recreate();
    expect((await reconstructed.restore.recover()).phase).toBe("compensated");
    expect(reconstructed.host.successfulStarts.filter((version) => version === "v2")).toHaveLength(1);
    const recoveryStart = reconstructed.host.actions.lastIndexOf("start:v2");
    expect(reconstructed.host.actions.lastIndexOf("verify_target:v2")).toBeLessThan(recoveryStart);
    expect(reconstructed.host.actions.lastIndexOf("verify_normal:v2")).toBeGreaterThan(recoveryStart);
  });

  it.each([
    { terminal: false, success: false, expected: "needs_reconciliation" },
    { terminal: true, success: false, expected: "compensated" },
  ])("RB-17 terminal=$terminal success=$success ends $expected", async ({ expected, ...verification }) => {
    const { host, journalPath, restore } = fixture();
    host.verificationOverrides.v1 = verification;
    const result = await restore.restore(await restore.preflight({ action: "restore_v1" }));
    expect(result.phase).toBe(expected);
    expect(journal(journalPath).phase).toBe(expected);
  });

  it.each(compensationEvidenceMatrix)(
    "RB-18 maps compensation fault %s to exact durable reconciliation evidence",
    async (fault, occurrence, lastProvenPhase, expectedPair) => {
      const { host, journalPath, restore, recreate } = fixture();
      host.failQueue.push("unit:v1");
      host.failOn(fault, occurrence);
      await expect(restore.restore(await restore.preflight({ action: "restore_v1" })))
        .rejects.toThrow(/compensation|reconciliation/i);
      const durable = journal(journalPath);
      expect(durable.phase).toBe("needs_reconciliation");
      expect(durable.lastProvenPhase).toBe(lastProvenPhase);
      expect(durable.operatorActions).toEqual([
        "inspect_physical_state", "retry_compensate_v2", "retain_v1_and_v2_evidence",
      ]);
      const expected = expectedPair === "v1" ? v1Target : v2Target;
      expect([host.physical.stateDatabase, host.physical.historyDatabase]).toEqual([
        expected.stateDatabase.sha256, expected.historyDatabase.sha256,
      ]);
      const reconstructed = recreate();
      const actions = [...reconstructed.host.actions];
      expect(await reconstructed.restore.recover()).toMatchObject({ phase: "needs_reconciliation" });
      expect(await reconstructed.restore.recover()).toMatchObject({ phase: "needs_reconciliation" });
      expect(reconstructed.host.actions).toEqual(actions);
      expect(reconstructed.host.physical.service.active).toBe(false);
      expect(reconstructed.host.retainedBundles).toEqual(new Set([v1Target.bundle.path, v2Target.bundle.path]));
      expect(reconstructed.host.retainedRoots).toEqual(new Set([v1Target.runtime.path, v2Target.runtime.path]));
      if (fault === "restore_state:v2") {
        await expect(restore.resolve({ action: "compensate_v2", nonce: "wrong" })).rejects.toThrow(/nonce/i);
        expect((await restore.resolve({ action: "compensate_v2", nonce: durable.nonce })).phase)
          .toBe("compensated");
        const resolvedActions = [...host.actions];
        expect((await restore.resolve({ action: "compensate_v2", nonce: durable.nonce })).phase)
          .toBe("compensated");
        expect(host.actions).toEqual(resolvedActions);
      }
    },
  );
});
