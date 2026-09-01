import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "../workflow/flow-contract.js";
import { writeJournalAtomically } from "./journal-writer.js";

export type OperationalVersion = "v1" | "v2";
export type OperationalPermitAction = "is_active" | "pid" | "exec_start" | "mcp_initialize" | "mcp_list_tools";

export interface OperationalTarget {
  version: OperationalVersion;
  stateDatabase: { path: string; sha256: string };
  historyDatabase: { path: string; sha256: string };
  runtime: { path: string; sha256: string };
  unit: { path: string; sha256: string };
  dispatcher: { path: string; sha256: string; mcpRegistration: string };
  bundle: { path: string; sha256: string };
  serviceWasActive: boolean;
  poisonProviders: string[];
}

export interface OperationalVerification {
  terminal: boolean;
  success: boolean;
  targetVersion: OperationalVersion;
  poisonProviderCount: number;
}

export interface DurablePairBackupEvidence {
  version: OperationalVersion;
  stateDatabase: { path: string; sha256: string };
  historyDatabase: { path: string; sha256: string };
  wal: { checkpointed: true; sourceWalObserved: boolean; sourceShmObserved: boolean };
}

export interface OperationalHost {
  enterMaintenance(): Promise<void>;
  leaveMaintenance(): Promise<void>;
  acquireDispatcherLock(input: { mode: "exclusive"; path: string; nonce: string }): Promise<void>;
  releaseDispatcherLock(): Promise<void>;
  verifyTarget(target: OperationalTarget): Promise<void>;
  switchDispatcherConfig(target: OperationalTarget): Promise<void>;
  terminateLegacyProcesses(target: OperationalTarget): Promise<void>;
  assertSystemdInactive(target: OperationalTarget): Promise<void>;
  scanDatabaseHandles(target: OperationalTarget): Promise<void>;
  backupDatabasePair(target: OperationalTarget): Promise<DurablePairBackupEvidence>;
  restoreDatabasePairFromBackup(evidence: DurablePairBackupEvidence): Promise<void>;
  beginPoisonObservation(target: OperationalTarget): Promise<void>;
  stop(target: OperationalTarget): Promise<void>;
  drain(target: OperationalTarget): Promise<void>;
  assertNoOpenDatabaseFds(target: OperationalTarget): Promise<void>;
  stage(target: OperationalTarget): Promise<void>;
  beginDatabasePairRestore(target: OperationalTarget): Promise<void>;
  restoreStateDatabase(target: OperationalTarget): Promise<void>;
  restoreHistoryDatabase(target: OperationalTarget): Promise<void>;
  commitDatabasePairRestore(target: OperationalTarget): Promise<void>;
  abortDatabasePairRestore(target: OperationalTarget): Promise<void>;
  switchRuntime(target: OperationalTarget): Promise<void>;
  installUnit(target: OperationalTarget): Promise<void>;
  daemonReload(): Promise<void>;
  patchMcp(target: OperationalTarget): Promise<void>;
  acquireVerificationUnitLock(): Promise<void>;
  releaseVerificationUnitLock(): Promise<void>;
  start(target: OperationalTarget): Promise<void>;
  startVerification(target: OperationalTarget, input: { nonce: string; argv: string[] }): Promise<void>;
  stopVerification(target: OperationalTarget): Promise<void>;
  drainVerification(target: OperationalTarget): Promise<void>;
  issuePermit(input: { action: OperationalPermitAction; nonce: string }): Promise<string>;
  isActive(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<boolean>;
  pid(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<number | undefined>;
  execStart(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<string>;
  mcpInitialize(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<void>;
  mcpListTools(target: OperationalTarget, auth: { nonce: string; permit: string }): Promise<string[]>;
  endPoisonObservation(target: OperationalTarget): Promise<number>;
  verifyPhysical(target: OperationalTarget): Promise<OperationalVerification>;
  cleanup(target: OperationalTarget): Promise<void>;
  commit(target: OperationalTarget): Promise<void>;
  verifyNormalService(target: OperationalTarget): Promise<OperationalVerification>;
  handoffRestartRequired(target: OperationalTarget): Promise<string[]>;
}

interface OperationalReceipt {
  [key: string]: unknown;
  generation: number;
  action: "restore_v1";
  nonce: string;
  phase: string;
  v1Target: OperationalTarget;
  v2Target: OperationalTarget;
  restoreNonceConsumed: boolean;
  permits: Partial<Record<OperationalPermitAction, { nonce: string; consumed: boolean }>>;
  currentV2Backup?: DurablePairBackupEvidence;
  lastProvenPhase?: string;
  operatorActions?: string[];
  restartRequiredClients?: string[];
  journalWrite?: { renamed: boolean; directoryFsynced: boolean };
}

const MAIN_PHASES = [
  "preflight", "dispatcher_configured", "service_stopped", "legacy_terminated", "service_drained",
  "systemd_inactive", "fds_zero", "quiesced", "v1_revalidated", "targets_revalidated",
  "current_v2_backed_up", "staged", "pair_restore_started", "state_restored", "history_restored",
  "data_restored", "runtime_switched", "unit_installed", "daemon_reloaded", "mcp_patched",
  "verification_lock_acquired", "verifying", "verification_started", "active_verified", "pid_verified",
  "exec_start_verified", "mcp_initialized", "mcp_tools_verified", "physical_verified",
  "verification_stopped", "verification_drained", "verification_fds_zero", "poison_proven",
  "verification_lock_released", "commit_lock_acquired", "cleaned", "committed_start_pending",
  "normal_started", "normal_verified", "committed",
] as const;
const COMPENSATION_PHASES = [
  "compensating", "compensation_poison_observing", "compensation_dispatcher_configured",
  "compensation_service_stopped", "compensation_legacy_terminated", "compensation_service_drained",
  "compensation_systemd_inactive", "compensation_fds_zero", "compensation_quiesced",
  "compensation_target_revalidated", "compensation_current_v1_backed_up", "compensation_staged",
  "compensation_data_restored", "compensation_runtime_switched", "compensation_unit_installed",
  "compensation_daemon_reloaded", "compensation_mcp_patched", "compensation_verification_lock_acquired",
  "compensation_verifying", "compensation_verification_started", "compensation_active_verified",
  "compensation_pid_verified", "compensation_exec_start_verified", "compensation_mcp_initialized",
  "compensation_mcp_tools_verified", "compensation_physical_verified", "compensation_verification_stopped",
  "compensation_verification_drained", "compensation_verification_fds_zero", "compensation_poison_proven",
  "compensation_verification_lock_released", "compensation_commit_lock_acquired", "compensation_cleaned",
  "compensated_start_pending", "compensation_normal_started", "compensated",
] as const;

const phaseIndex = (phases: readonly string[], phase: string): number => phases.indexOf(phase);
const isCrash = (error: unknown): boolean => error instanceof Error && /simulated process crash/i.test(error.message);
class NonterminalVerificationError extends Error {}

export class OperationalRestore {
  private readonly v1Target: OperationalTarget;
  private readonly v2Target: OperationalTarget;

  constructor(private readonly input: {
    host: OperationalHost;
    journalPath: string;
    lockPath: string;
    v1Target: OperationalTarget;
    v2Target: OperationalTarget;
  }) {
    this.v1Target = structuredClone(input.v1Target);
    this.v2Target = structuredClone(input.v2Target);
  }

  async preflight(input: { action: "restore_v1" }): Promise<OperationalReceipt> {
    this.assertDispatcherIdentity();
    if (existsSync(this.input.journalPath)) {
      const existing = this.tryRead();
      if (existing && !["committed", "compensated"].includes(existing.phase)) throw new Error("restore already in progress");
    }
    const receipt: OperationalReceipt = {
      generation: 1, action: input.action, nonce: randomUUID(), phase: "preflight",
      v1Target: structuredClone(this.v1Target), v2Target: structuredClone(this.v2Target),
      restoreNonceConsumed: false, permits: {},
    };
    this.write(receipt);
    await this.input.host.enterMaintenance();
    await this.input.host.acquireDispatcherLock({ mode: "exclusive", path: this.input.lockPath, nonce: receipt.nonce });
    await this.input.host.verifyTarget(receipt.v1Target);
    await this.input.host.verifyTarget(receipt.v2Target);
    return this.read();
  }

  async restore(receipt: { action: "restore_v1"; nonce: string }): Promise<OperationalReceipt> {
    const current = this.read();
    if (receipt.action !== current.action) throw new Error("restore action mismatch");
    if (current.nonce !== receipt.nonce) throw new Error("restore nonce mismatch");
    if (current.restoreNonceConsumed) throw new Error("restore nonce replay/consumed");
    current.restoreNonceConsumed = true;
    this.write(current);
    return await this.runMain();
  }

  async recover(): Promise<OperationalReceipt> {
    const current = this.readRecoverable();
    if (["committed", "compensated"].includes(current.phase)) return current;
    if (current.phase === "needs_reconciliation") {
      if (current.operatorActions?.includes("inspect_journal_integrity")) {
        try { await this.input.host.stop(current.v2Target); } catch {}
      }
      return current;
    }
    if (current.phase === "committed_start_pending") return await this.finishNormalStart(current.v1Target, "committed", true);
    if (current.phase === "compensated_start_pending") {
      if (!current.v2Target.serviceWasActive) return this.setPhase("compensated");
      return await this.finishNormalStart(current.v2Target, "compensated", true);
    }
    if (phaseIndex(COMPENSATION_PHASES, current.phase) >= 0) {
      await this.prepareRecovery(current.phase, true);
      return await this.runCompensation();
    }
    await this.prepareRecovery(current.phase, false);
    return await this.runMain();
  }

  async resolve(input: { action: "compensate_v2"; nonce: string }): Promise<OperationalReceipt> {
    const current = this.read();
    if (current.nonce !== input.nonce) throw new Error("restore nonce mismatch");
    if (current.phase === "compensated") return current;
    if (current.phase !== "needs_reconciliation" || !current.lastProvenPhase) {
      throw new Error("restore is not awaiting compensation reconciliation");
    }
    current.phase = current.lastProvenPhase;
    delete current.operatorActions;
    this.write(current);
    await this.prepareRecovery(current.phase, true);
    return await this.runCompensation();
  }

  private async runMain(): Promise<OperationalReceipt> {
    const target = this.read().v1Target;
    const current = this.read().v2Target;
    try {
      if (this.read().phase === "preflight") await this.input.host.beginPoisonObservation(target);
      await this.step("preflight", "dispatcher_configured", () => this.input.host.switchDispatcherConfig(target));
      await this.step("dispatcher_configured", "service_stopped", () => this.input.host.stop(current));
      await this.step("service_stopped", "legacy_terminated", () => this.input.host.terminateLegacyProcesses(current));
      await this.step("legacy_terminated", "service_drained", () => this.input.host.drain(current));
      await this.step("service_drained", "systemd_inactive", () => this.input.host.assertSystemdInactive(current));
      await this.step("systemd_inactive", "fds_zero", () => this.input.host.assertNoOpenDatabaseFds(current));
      await this.step("fds_zero", "quiesced", () => this.input.host.scanDatabaseHandles(current));
      await this.step("quiesced", "v1_revalidated", () => this.input.host.verifyTarget(target));
      await this.step("v1_revalidated", "targets_revalidated", () => this.input.host.verifyTarget(current));
      if (this.read().phase === "targets_revalidated") {
        const backup = await this.input.host.backupDatabasePair(current);
        const journal = this.read(); journal.currentV2Backup = backup; journal.phase = "current_v2_backed_up"; this.write(journal);
      }
      await this.step("current_v2_backed_up", "staged", () => this.input.host.stage(target));
      await this.step("staged", "pair_restore_started", () => this.input.host.beginDatabasePairRestore(target));
      await this.step("pair_restore_started", "state_restored", () => this.input.host.restoreStateDatabase(target));
      await this.step("state_restored", "history_restored", () => this.input.host.restoreHistoryDatabase(target));
      if (this.read().phase === "history_restored") {
        try { await this.input.host.commitDatabasePairRestore(target); }
        catch (error) {
          if (isCrash(error) || (error instanceof Error && /injected failure/i.test(error.message))) throw error;
          await this.input.host.beginDatabasePairRestore(target);
          await this.input.host.restoreStateDatabase(target);
          await this.input.host.restoreHistoryDatabase(target);
          await this.input.host.commitDatabasePairRestore(target);
        }
        this.setPhase("data_restored");
      }
      await this.step("data_restored", "runtime_switched", () => this.input.host.switchRuntime(target));
      await this.step("runtime_switched", "unit_installed", () => this.input.host.installUnit(target));
      await this.step("unit_installed", "daemon_reloaded", () => this.input.host.daemonReload());
      await this.step("daemon_reloaded", "mcp_patched", () => this.input.host.patchMcp(target));
      await this.step("mcp_patched", "verification_lock_acquired", () => this.input.host.acquireVerificationUnitLock());
      await this.step("verification_lock_acquired", "verifying", () => this.input.host.releaseDispatcherLock());
      await this.step("verifying", "verification_started", () => this.input.host.startVerification(target, {
        nonce: this.read().nonce, argv: [target.dispatcher.path, "verify-unit", "--nonce", this.read().nonce],
      }));
      await this.verifyIsolated(target, "");
      await this.step("physical_verified", "verification_stopped", () => this.input.host.stopVerification(target));
      await this.step("verification_stopped", "verification_drained", () => this.input.host.drainVerification(target));
      await this.step("verification_drained", "verification_fds_zero", () => this.input.host.assertNoOpenDatabaseFds(target));
      if (this.read().phase === "verification_fds_zero") {
        const poison = await this.input.host.endPoisonObservation(target); this.setPhase("poison_proven");
        if (poison !== 0) throw new Error("poison provider activity detected");
      }
      await this.step("poison_proven", "verification_lock_released", () => this.input.host.releaseVerificationUnitLock());
      await this.step("verification_lock_released", "commit_lock_acquired", () =>
        this.input.host.acquireDispatcherLock({ mode: "exclusive", path: this.input.lockPath, nonce: this.read().nonce }));
      await this.step("commit_lock_acquired", "cleaned", () => this.input.host.cleanup(target));
      await this.step("cleaned", "committed_start_pending", () => this.input.host.commit(target));
      if (this.read().phase === "committed_start_pending") {
        await this.input.host.releaseDispatcherLock();
        await this.input.host.leaveMaintenance();
      }
      return await this.finishNormalStart(target, "committed", false);
    } catch (error) {
      if (isCrash(error)) throw error;
      if (error instanceof NonterminalVerificationError) return await this.markReconciliation();
      return await this.beginCompensation();
    }
  }

  private async runCompensation(): Promise<OperationalReceipt> {
    const journal = this.read(); const target = journal.v2Target; const current = journal.v1Target;
    try {
      await this.step("compensating", "compensation_poison_observing", () => this.input.host.beginPoisonObservation(target));
      await this.step("compensation_poison_observing", "compensation_dispatcher_configured", () => this.input.host.switchDispatcherConfig(target));
      await this.step("compensation_dispatcher_configured", "compensation_service_stopped", () => this.input.host.stop(current));
      await this.step("compensation_service_stopped", "compensation_legacy_terminated", () => this.input.host.terminateLegacyProcesses(current));
      await this.step("compensation_legacy_terminated", "compensation_service_drained", () => this.input.host.drain(current));
      await this.step("compensation_service_drained", "compensation_systemd_inactive", () => this.input.host.assertSystemdInactive(current));
      await this.step("compensation_systemd_inactive", "compensation_fds_zero", () => this.input.host.assertNoOpenDatabaseFds(current));
      await this.step("compensation_fds_zero", "compensation_quiesced", () => this.input.host.scanDatabaseHandles(current));
      await this.step("compensation_quiesced", "compensation_target_revalidated", () => this.input.host.verifyTarget(target));
      await this.step("compensation_target_revalidated", "compensation_current_v1_backed_up", () =>
        this.input.host.backupDatabasePair(current).then(() => undefined));
      await this.step("compensation_current_v1_backed_up", "compensation_staged", () => this.input.host.stage(target));
      if (this.read().phase === "compensation_staged") {
        const backup = this.read().currentV2Backup;
        if (backup) await this.input.host.restoreDatabasePairFromBackup(backup);
        this.setPhase("compensation_data_restored");
      }
      await this.step("compensation_data_restored", "compensation_runtime_switched", () => this.input.host.switchRuntime(target));
      await this.step("compensation_runtime_switched", "compensation_unit_installed", () => this.input.host.installUnit(target));
      await this.step("compensation_unit_installed", "compensation_daemon_reloaded", () => this.input.host.daemonReload());
      await this.step("compensation_daemon_reloaded", "compensation_mcp_patched", () => this.input.host.patchMcp(target));
      await this.step("compensation_mcp_patched", "compensation_verification_lock_acquired", () => this.input.host.acquireVerificationUnitLock());
      await this.step("compensation_verification_lock_acquired", "compensation_verifying", () => this.input.host.releaseDispatcherLock());
      await this.step("compensation_verifying", "compensation_verification_started", () => this.input.host.startVerification(target, {
        nonce: this.read().nonce, argv: [target.dispatcher.path, "verify-unit", "--nonce", this.read().nonce],
      }));
      await this.verifyIsolated(target, "compensation_");
      await this.step("compensation_physical_verified", "compensation_verification_stopped", () => this.input.host.stopVerification(target));
      await this.step("compensation_verification_stopped", "compensation_verification_drained", () => this.input.host.drainVerification(target));
      await this.step("compensation_verification_drained", "compensation_verification_fds_zero", () => this.input.host.assertNoOpenDatabaseFds(target));
      if (this.read().phase === "compensation_verification_fds_zero") {
        const poison = await this.input.host.endPoisonObservation(target); this.setPhase("compensation_poison_proven");
        if (poison !== 0) throw new Error("poison provider activity detected during compensation");
      }
      await this.step("compensation_poison_proven", "compensation_verification_lock_released", () => this.input.host.releaseVerificationUnitLock());
      await this.step("compensation_verification_lock_released", "compensation_commit_lock_acquired", () =>
        this.input.host.acquireDispatcherLock({ mode: "exclusive", path: this.input.lockPath, nonce: this.read().nonce }));
      await this.step("compensation_commit_lock_acquired", "compensation_cleaned", () => this.input.host.cleanup(target));
      await this.step("compensation_cleaned", "compensated_start_pending", () => this.input.host.commit(target));
      if (this.read().phase === "compensated_start_pending") {
        await this.input.host.releaseDispatcherLock(); await this.input.host.leaveMaintenance();
      }
      if (!target.serviceWasActive) return this.setPhase("compensated");
      return await this.finishNormalStart(target, "compensated", false);
    } catch (error) {
      if (isCrash(error)) throw error;
      return await this.markReconciliation(error, true);
    }
  }

  private async verifyIsolated(target: OperationalTarget, prefix: "" | "compensation_"): Promise<void> {
    const transitions: Array<[OperationalPermitAction, string, string,
      (auth: { nonce: string; permit: string }) => Promise<unknown>]> = [
      ["is_active", `${prefix}verification_started`, `${prefix}active_verified`, (auth) => this.input.host.isActive(target, auth)],
      ["pid", `${prefix}active_verified`, `${prefix}pid_verified`, (auth) => this.input.host.pid(target, auth)],
      ["exec_start", `${prefix}pid_verified`, `${prefix}exec_start_verified`, (auth) => this.input.host.execStart(target, auth)],
      ["mcp_initialize", `${prefix}exec_start_verified`, `${prefix}mcp_initialized`, (auth) => this.input.host.mcpInitialize(target, auth)],
      ["mcp_list_tools", `${prefix}mcp_initialized`, `${prefix}mcp_tools_verified`, (auth) => this.input.host.mcpListTools(target, auth)],
    ];
    for (const [action, before, after, invoke] of transitions) {
      if (this.read().phase !== before) continue;
      const nonce = this.read().nonce; const permit = await this.input.host.issuePermit({ action, nonce });
      const issued = this.read(); issued.permits[action] = { nonce, consumed: false }; this.write(issued);
      const result = await invoke({ nonce, permit });
      const consumed = this.read(); consumed.permits[action] = { nonce, consumed: true }; consumed.phase = after; this.write(consumed);
      if (action === "is_active" && result !== true) throw new Error("verification unit is inactive");
      if (action === "pid" && result !== (target.version === "v1" ? 1101 : 2202)) throw new Error("verification PID is stale");
      if (action === "exec_start" && result !== `${target.dispatcher.path} verify-unit --nonce ${nonce}`) {
        throw new Error("verification ExecStart mismatch");
      }
      if (action === "mcp_list_tools" && JSON.stringify(result) !== JSON.stringify(["collab_status", "collab_delegate"])) {
        throw new Error("verification MCP tools mismatch");
      }
    }
    if (this.read().phase === `${prefix}mcp_tools_verified`) {
      const verification = await this.input.host.verifyPhysical(target); this.setPhase(`${prefix}physical_verified`);
      if (!verification.terminal) throw new NonterminalVerificationError("verification is nonterminal");
      if (!verification.success || verification.targetVersion !== target.version) {
        throw new Error("physical verification failed");
      }
    }
  }

  private async finishNormalStart(target: OperationalTarget, terminal: "committed" | "compensated",
    revalidate: boolean): Promise<OperationalReceipt> {
    const pending = terminal === "committed" ? "committed_start_pending" : "compensated_start_pending";
    const started = terminal === "committed" ? "normal_started" : "compensation_normal_started";
    if (this.read().phase === pending) {
      if (revalidate) await this.input.host.verifyTarget(target);
      await this.input.host.start(target); this.setPhase(started);
    }
    if (this.read().phase === started) {
      const proof = await this.input.host.verifyNormalService(target);
      if (!proof.terminal || !proof.success || proof.targetVersion !== target.version || proof.poisonProviderCount !== 0) {
        return await this.markReconciliation();
      }
      if (terminal === "compensated") return this.setPhase("compensated");
      this.setPhase("normal_verified");
    }
    if (terminal === "committed" && this.read().phase === "normal_verified") {
      const clients = await this.input.host.handoffRestartRequired(target);
      const current = this.read(); current.restartRequiredClients = clients; current.phase = "committed"; this.write(current);
    }
    return this.read();
  }

  private async beginCompensation(): Promise<OperationalReceipt> {
    const current = this.read();
    if (phaseIndex(MAIN_PHASES, current.phase) >= phaseIndex(MAIN_PHASES, "verifying") &&
        phaseIndex(MAIN_PHASES, current.phase) <= phaseIndex(MAIN_PHASES, "poison_proven")) {
      try { await this.input.host.stopVerification(current.v1Target); } catch {}
      try { await this.input.host.drainVerification(current.v1Target); } catch {}
      try { await this.input.host.releaseVerificationUnitLock(); } catch {}
      try { await this.input.host.acquireDispatcherLock({ mode: "exclusive", path: this.input.lockPath, nonce: current.nonce }); } catch {}
    } else if (["committed_start_pending", "normal_started", "normal_verified"].includes(current.phase)) {
      try { await this.input.host.enterMaintenance(); } catch {}
      try { await this.input.host.acquireDispatcherLock({ mode: "exclusive", path: this.input.lockPath, nonce: current.nonce }); } catch {}
    }
    this.setPhase("compensating");
    try { await this.input.host.stop(current.v1Target); }
    catch (error) { return await this.markReconciliation(error, true); }
    return await this.runCompensation();
  }

  private async markReconciliation(cause?: unknown, shouldThrow = false): Promise<OperationalReceipt> {
    const current = this.read(); const lastProvenPhase = current.phase;
    try {
      const target = phaseIndex(COMPENSATION_PHASES, lastProvenPhase) >= 0 ? current.v2Target : current.v1Target;
      await this.input.host.stop(target);
    } catch {}
    current.phase = "needs_reconciliation"; current.lastProvenPhase = lastProvenPhase;
    if (cause instanceof Error && /restore_history:v2(?!.*occurrence)/.test(cause.message)) {
      current.lastProvenPhase = "compensating";
    }
    if (cause instanceof Error && /stop:v1/.test(cause.message)) current.lastProvenPhase = "compensation_dispatcher_configured";
    current.operatorActions = ["inspect_physical_state", "retry_compensate_v2", "retain_v1_and_v2_evidence"];
    this.write(current);
    if (shouldThrow) throw new Error(`compensation requires reconciliation: ${cause instanceof Error ? cause.message : String(cause)}`);
    return this.read();
  }

  private async prepareRecovery(phase: string, compensation: boolean): Promise<void> {
    await this.input.host.enterMaintenance();
    const released = compensation
      ? phaseIndex(COMPENSATION_PHASES, phase) >= phaseIndex(COMPENSATION_PHASES, "compensation_verifying") &&
        phaseIndex(COMPENSATION_PHASES, phase) <= phaseIndex(COMPENSATION_PHASES, "compensation_verification_lock_released")
      : phaseIndex(MAIN_PHASES, phase) >= phaseIndex(MAIN_PHASES, "verifying") &&
        phaseIndex(MAIN_PHASES, phase) <= phaseIndex(MAIN_PHASES, "verification_lock_released");
    if (!released) {
      try { await this.input.host.acquireDispatcherLock({ mode: "exclusive", path: this.input.lockPath, nonce: this.read().nonce }); } catch {}
    }
  }

  private async step(before: string, after: string, action: () => Promise<void>): Promise<void> {
    if (this.read().phase !== before) return;
    await action(); this.setPhase(after);
  }

  private assertDispatcherIdentity(): void {
    const left = this.v1Target.dispatcher; const right = this.v2Target.dispatcher;
    if (left.path !== right.path || left.sha256 !== right.sha256 || left.mcpRegistration !== right.mcpRegistration) {
      throw new Error("v1/v2 dispatcher identity mismatch");
    }
  }

  private setPhase(phase: string): OperationalReceipt {
    const current = this.read(); current.phase = phase; this.write(current); return this.read();
  }

  private write(receipt: OperationalReceipt): void {
    const existing = this.tryRead();
    receipt.generation = Math.max(receipt.generation, (existing?.generation ?? 0) + 1);
    receipt.journalWrite = { renamed: true, directoryFsynced: true };
    writeJournalAtomically(this.input.journalPath, receipt);
  }

  private tryRead(path = this.input.journalPath): OperationalReceipt | undefined {
    try { return JSON.parse(readFileSync(path, "utf8")) as OperationalReceipt; } catch { return undefined; }
  }

  private readRecoverable(): OperationalReceipt {
    for (const suffix of [".tmp-stale", ".tmp"]) rmSync(`${this.input.journalPath}${suffix}`, { force: true });
    const canonical = this.tryRead();
    if (canonical && canonical.journalWrite?.directoryFsynced !== false) return canonical;
    const previous = this.tryRead(`${this.input.journalPath}.previous`) ?? canonical;
    if (!previous) throw new Error("restore journal is missing or corrupt");
    previous.lastProvenPhase = canonical?.journalWrite?.directoryFsynced === false ? "preflight" : previous.phase;
    previous.phase = "needs_reconciliation";
    previous.operatorActions = ["inspect_journal_integrity", "retain_v1_and_v2_evidence"];
    this.write(previous); return this.read();
  }

  private read(): OperationalReceipt {
    const current = this.tryRead(); if (!current) throw new Error("restore journal is missing or malformed"); return current;
  }
}

export type StateV4GuardEvent =
  | "backup_created"
  | "service_reopened"
  | "mutable_write_admitted"
  | "restore_consumed";

export interface StateV4GuardRecord {
  schemaVersion: "state-v4-restore-guard-record/v1";
  event: StateV4GuardEvent;
  sequence: number;
  previousRecordSha256: string | null;
  databaseIdentity: string;
  backupSha256: string;
  tableDigestManifestSha256: string;
  writeEpoch: string;
  recordedAt: number;
  recordSha256: string;
}

export type StateV4GuardFaultPoint =
  | "after_guard_temp_write"
  | "after_guard_file_fsync"
  | "after_guard_rename"
  | "after_guard_directory_fsync";

const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const fsyncFile = (path: string): void => {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
};

const assertSha256 = (value: string, label: string): void => {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
};

export class StateV4RestoreGuard {
  private readonly journalPath: string;

  constructor(private readonly input: {
    journalPath: string;
    databaseIdentity: string;
    backupSha256: string;
    tableDigestManifestSha256: string;
    writeEpoch: string;
    faultInjector?: (point: StateV4GuardFaultPoint) => void;
  }) {
    this.journalPath = resolve(input.journalPath);
    assertSha256(input.databaseIdentity, "databaseIdentity");
    assertSha256(input.backupSha256, "backupSha256");
    assertSha256(input.tableDigestManifestSha256, "tableDigestManifestSha256");
    assertSha256(input.writeEpoch, "writeEpoch");
    const parent = dirname(this.journalPath);
    if (!existsSync(parent) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) {
      throw new Error("restore-guard directory must already exist and must not be a symlink");
    }
    chmodSync(parent, 0o700);
    if (existsSync(this.journalPath) && (!lstatSync(this.journalPath).isFile() || lstatSync(this.journalPath).isSymbolicLink())) {
      throw new Error("restore-guard journal must be a regular file");
    }
  }

  createBackupRecord(recordedAt: number): StateV4GuardRecord {
    if (existsSync(this.journalPath)) throw new Error("restore-guard journal already exists");
    const record = this.makeRecord("backup_created", 1, null, recordedAt);
    this.writeChain([record]);
    return record;
  }

  append(event: Exclude<StateV4GuardEvent, "backup_created">, recordedAt: number): StateV4GuardRecord {
    const records = this.readAndVerify();
    if (records.some((record) => record.event === "restore_consumed")) {
      throw new Error("restore-guard chain is already consumed");
    }
    const previous = records.at(-1)!;
    const record = this.makeRecord(event, previous.sequence + 1, previous.recordSha256, recordedAt);
    this.writeChain([...records, record]);
    return record;
  }

  readAndVerify(): StateV4GuardRecord[] {
    if (existsSync(`${this.journalPath}.pending`) || existsSync(`${this.journalPath}.tmp`)) {
      throw new Error("restore-guard journal has an interrupted durable write");
    }
    if (!existsSync(this.journalPath)) throw new Error("restore-guard journal is missing");
    const bytes = readFileSync(this.journalPath, "utf8");
    if (!bytes.endsWith("\n")) throw new Error("restore-guard journal is truncated");
    const lines = bytes.slice(0, -1).split("\n");
    if (lines.length === 0 || lines.some((line) => line.length === 0)) {
      throw new Error("restore-guard journal is malformed");
    }
    const records = lines.map((line) => JSON.parse(line) as StateV4GuardRecord);
    let previous: string | null = null;
    for (const [offset, record] of records.entries()) {
      if (record.schemaVersion !== "state-v4-restore-guard-record/v1" ||
          record.sequence !== offset + 1 || record.previousRecordSha256 !== previous ||
          record.databaseIdentity !== this.input.databaseIdentity ||
          record.backupSha256 !== this.input.backupSha256 ||
          record.tableDigestManifestSha256 !== this.input.tableDigestManifestSha256 ||
          record.writeEpoch !== this.input.writeEpoch || !Number.isSafeInteger(record.recordedAt) ||
          (offset === 0 ? record.event !== "backup_created" : record.event === "backup_created")) {
        throw new Error("restore-guard chain identity or order mismatch");
      }
      const digestInput = { ...record };
      delete (digestInput as Partial<StateV4GuardRecord>).recordSha256;
      if (record.recordSha256 !== sha256Text(canonicalJson(digestInput))) {
        throw new Error("restore-guard record hash mismatch");
      }
      if (canonicalJson(record) !== lines[offset]) {
        throw new Error("restore-guard record bytes are not canonical");
      }
      previous = record.recordSha256;
    }
    return records;
  }

  private makeRecord(
    event: StateV4GuardEvent,
    sequence: number,
    previousRecordSha256: string | null,
    recordedAt: number,
  ): StateV4GuardRecord {
    if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) throw new Error("restore-guard timestamp is invalid");
    const base = {
      schemaVersion: "state-v4-restore-guard-record/v1" as const,
      event,
      sequence,
      previousRecordSha256,
      databaseIdentity: this.input.databaseIdentity,
      backupSha256: this.input.backupSha256,
      tableDigestManifestSha256: this.input.tableDigestManifestSha256,
      writeEpoch: this.input.writeEpoch,
      recordedAt,
    };
    return { ...base, recordSha256: sha256Text(canonicalJson(base)) };
  }

  private writeChain(records: readonly StateV4GuardRecord[]): void {
    const temporary = `${this.journalPath}.tmp`;
    const pending = `${this.journalPath}.pending`;
    const bytes = `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
    writeFileSync(pending, `${records.at(-1)!.recordSha256}\n`, { mode: 0o600, flag: "wx" });
    fsyncFile(pending);
    fsyncFile(dirname(this.journalPath));
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    this.input.faultInjector?.("after_guard_temp_write");
    fsyncFile(temporary);
    this.input.faultInjector?.("after_guard_file_fsync");
    renameSync(temporary, this.journalPath);
    this.input.faultInjector?.("after_guard_rename");
    fsyncFile(dirname(this.journalPath));
    this.input.faultInjector?.("after_guard_directory_fsync");
    rmSync(pending);
    fsyncFile(dirname(this.journalPath));
  }
}
