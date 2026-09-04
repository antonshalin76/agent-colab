import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineMigrationQuiescence, type OfflineProcessScan } from "./offline-quiescence.js";
import type { MigrationResult } from "./coordinator.js";
import { runReviewedV4MigrationKernel } from "./internal/reviewed-v4-kernel.js";
import {
  assertDatabasePairCurrent,
  assertHistoryUnchanged,
  bindDatabasePair,
  verifyCurrentReviewedV4Database,
  verifyMigratedDatabaseAtBoundary,
  verifyRecoveryAuthority,
} from "./reviewed-v4-bootstrap.js";
import {
  createReviewedV4MigrationAuthority,
  type MigrationAuthorityBinding,
  type MigrationAuthorityClaim,
  type MigrationAuthorityInspection,
} from "./reviewed-v4-migration-authority.js";
import { acquireStateOpenAdmission } from "../store/state-open-admission.js";
import { openExistingStateLayout } from "../store/state-layout.js";
import {
  inspectReviewedV4ExecutionSource,
  verifyReviewedV4Source,
} from "../flow/reviewed-v4-source.js";
import {
  adoptReviewedV4SourceAcceptance,
  consumeReviewedV4SourceAcceptance,
  type ReviewedV4PromotionTrust,
  type ReviewedV4SourceAcceptanceResult,
} from "./reviewed-v4-source-acceptance.js";
import { observeLegacyDatabase } from "./state-v4-manifest.js";
import { canonicalJson } from "../domain/canonical-json.js";
import { runUserSystemctl } from "../runtime/systemd-user.js";

const OPERATION_ID = "stg04-production-close" as const;
const SHA256 = /^[a-f0-9]{64}$/;

export const resolveReviewedV4ProductionSourceRoot = (): string =>
  realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));

const assertSourceLauncherExecution = (): void => {
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  if (!modulePath.endsWith("/src/migration/reviewed-v4-production-process.ts")) {
    throw new Error("reviewed v4 production close must execute through the source launcher; dist execution is forbidden");
  }
};

const configuredPromotionTrust = (repositoryRoot: string): ReviewedV4PromotionTrust => {
  const publicKeyPath = process.env.AGENT_COLLAB_REVIEWED_SOURCE_PUBLIC_KEY_FILE;
  const url = process.env.AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_URL;
  const ref = process.env.AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_REF;
  if (!publicKeyPath || !url || !ref) {
    throw new Error("reviewed v4 production promotion trust is not configured");
  }
  if (!isAbsolute(publicKeyPath) || resolve(publicKeyPath) !== publicKeyPath ||
      realpathSync(publicKeyPath) !== publicKeyPath) {
    throw new Error("reviewed v4 production public key file must be absolute, canonical and no-follow");
  }
  const descriptor = openSync(publicKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let publicKeyPem: Buffer;
  try {
    const before = fstatSync(descriptor);
    const pathBefore = lstatSync(publicKeyPath);
    publicKeyPem = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(publicKeyPath);
    const expectedUid = process.getuid?.();
    if (!before.isFile() || !pathBefore.isFile() || pathBefore.isSymbolicLink() ||
        before.nlink !== 1 || pathBefore.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
        (expectedUid !== undefined && before.uid !== expectedUid) ||
        before.dev !== pathBefore.dev || before.ino !== pathBefore.ino ||
        before.dev !== after.dev || before.ino !== after.ino ||
        after.dev !== pathAfter.dev || after.ino !== pathAfter.ino) {
      throw new Error("reviewed v4 production public key file identity or mode is invalid");
    }
  } finally {
    closeSync(descriptor);
  }
  return { publicKeyPem, repositoryRoot, remote: { url, ref } };
};

export function adoptProductionReviewedV4Source(input: {
  readonly stateRoot: string;
  readonly externalPromotionPath: string;
}): ReviewedV4SourceAcceptanceResult {
  assertSourceLauncherExecution();
  const allowedKeys = new Set(["stateRoot", "externalPromotionPath"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("unknown production source adoption input is not permitted");
  }
  const repositoryRoot = resolveReviewedV4ProductionSourceRoot();
  return adoptReviewedV4SourceAcceptance({
    stateRoot: input.stateRoot,
    externalPromotionPath: input.externalPromotionPath,
    trust: configuredPromotionTrust(repositoryRoot),
  });
}

function managedServiceState(): "active" | "inactive" | "unknown" {
  let unknown = false;
  for (const unit of ["agent-collab.service", "agent-collab-reviewed.service"]) {
    const result = runUserSystemctl(["is-active", unit]);
    const state = result.stdout.trim();
    if (state === "active" || result.status === 0) return "active";
    if (state !== "inactive" && state !== "failed" && state !== "unknown" &&
        result.status !== 3 && result.status !== 4) unknown = true;
  }
  return unknown ? "unknown" : "inactive";
}

const isVanishedProcEntry = (error: unknown): boolean =>
  error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code));

function scanSameUidOpenFiles(targetPaths: readonly string[]): OfflineProcessScan {
  const files: Array<{ pid: number; path: string; dev: number; ino: number }> = [];
  const unreadableSameUidPids: number[] = [];
  const uid = process.getuid?.();
  for (const path of targetPaths) {
    if (!existsSync(path)) continue;
    const result = spawnSync("/usr/bin/fuser", [path], { encoding: "utf8", shell: false });
    if (result.error || (result.status !== 0 && result.status !== 1) || /permission denied/i.test(result.stderr)) {
      unreadableSameUidPids.push(-1);
      continue;
    }
    if (result.status === 0) {
      const identity = statSync(path);
      const pids = result.stdout.match(/\d+/g)?.map(Number) ?? [];
      if (pids.length === 0) unreadableSameUidPids.push(-1);
      for (const pid of pids) files.push({ pid, path, dev: identity.dev, ino: identity.ino });
    }
  }
  const mustInspect = (pid: number): boolean => {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return command.includes("agent-collab") || command.includes("collaboration.db") || command.includes("history.db");
    } catch (error) {
      return !isVanishedProcEntry(error);
    }
  };
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const processRoot = join("/proc", entry.name);
    try {
      if (uid !== undefined && statSync(processRoot).uid !== uid) continue;
    } catch (error) {
      if (!isVanishedProcEntry(error) && mustInspect(pid)) unreadableSameUidPids.push(pid);
      continue;
    }
    let descriptors: string[];
    try { descriptors = readdirSync(join(processRoot, "fd")); }
    catch (error) {
      if (!isVanishedProcEntry(error) && mustInspect(pid)) unreadableSameUidPids.push(pid);
      continue;
    }
    for (const descriptor of descriptors) {
      const fd = join(processRoot, "fd", descriptor);
      try {
        const path = readlinkSync(fd);
        const identity = statSync(fd);
        files.push({ pid, path, dev: identity.dev, ino: identity.ino });
      } catch (error) {
        if (!isVanishedProcEntry(error) && mustInspect(pid)) {
          unreadableSameUidPids.push(pid);
          break;
        }
      }
    }
  }
  return { files, unreadableSameUidPids: [...new Set(unreadableSameUidPids)] };
}

const receiptForProcess = (result: MigrationResult): Record<string, unknown> => {
  if (result.status === "migrated" && result.toVersion === 4) return { ...result };
  if (result.status === "already_current" && result.toVersion === 4) return { ...result };
  throw new Error("in-process reviewed migration returned an unsupported schema result");
};

export function createProductionReviewedV4MigrationProcess(input: {
  readonly stateRoot: string;
  readonly sourceAcceptanceReceiptSha256: string;
  readonly promotionTrust?: ReviewedV4PromotionTrust;
  readonly faultInjector?: (point: "after_v4_coordinator_return") => void;
}) {
  assertSourceLauncherExecution();
  const allowedKeys = new Set(["stateRoot", "sourceAcceptanceReceiptSha256", "promotionTrust", "faultInjector"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("caller-controlled source root or unknown production input is not permitted");
  }
  if (!SHA256.test(input.sourceAcceptanceReceiptSha256)) {
    throw new Error("production source acceptance receipt digest is invalid");
  }
  const layout = openExistingStateLayout(input.stateRoot);
  const repositoryRoot = resolveReviewedV4ProductionSourceRoot();
  const promotionTrust = input.promotionTrust ?? configuredPromotionTrust(repositoryRoot);
  if (realpathSync(resolve(promotionTrust.repositoryRoot)) !== repositoryRoot) {
    throw new Error("reviewed v4 production trust repository root does not match the source launcher root");
  }
  const planLockBytes = readFileSync(join(repositoryRoot, "docs/hybrid-flow-v1-r2/PLAN_LOCK.json"));
  const planLock = JSON.parse(planLockBytes.toString("utf8")) as { planId?: unknown };
  if (typeof planLock.planId !== "string" || !planLock.planId) {
    throw new Error("production plan lock has no plan identity");
  }
  const planLockSha256 = createHash("sha256").update(planLockBytes).digest("hex");
  let migrationAuthority: ReturnType<typeof createReviewedV4MigrationAuthority> | undefined;
  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw new Error("reviewed v4 production migration process is closed");
  };
  const verifyExecutionSource = () => {
    const acceptance = consumeReviewedV4SourceAcceptance({
      stateRoot: layout.root,
      adoptionSha256: input.sourceAcceptanceReceiptSha256,
      trust: promotionTrust,
    });
    if (acceptance.planIdentity.planId !== planLock.planId ||
        acceptance.planIdentity.planLockSha256 !== planLockSha256) {
      throw new Error("reviewed v4 source adoption plan identity does not match the production plan lock");
    }
    const source = inspectReviewedV4ExecutionSource({
      repositoryRoot,
      expected: acceptance.sourceIdentity,
      remote: acceptance.remote,
    });
    verifyReviewedV4Source(source, acceptance.sourceIdentity);
    return acceptance;
  };
  const authorityBinding = (acceptance: ReviewedV4SourceAcceptanceResult): MigrationAuthorityBinding => ({
    operationId: OPERATION_ID,
    consumer: "codex:/root:state-v4-reviewed-bootstrap",
    scope: "reviewed-state-v4-migration",
    adoptionSha256: acceptance.receiptSha256,
    promotionSha256: acceptance.promotionSha256,
    sourceIdentity: acceptance.sourceIdentity,
    targetIdentity: {
      root: { path: acceptance.target.root.path, dev: acceptance.target.root.dev, ino: acceptance.target.root.ino },
      state: { ...acceptance.target.state },
      history: { ...acceptance.target.history },
    },
    stateDatabase: layout.database,
    historyDatabase: layout.historyDatabase,
  });
  const quiescence = createOfflineMigrationQuiescence({
    serviceState: managedServiceState,
    scanSameUidOpenFiles: () => scanSameUidOpenFiles([
      layout.database,
      `${layout.database}-wal`,
      `${layout.database}-shm`,
      `${layout.database}-journal`,
      layout.historyDatabase,
      `${layout.historyDatabase}-wal`,
      `${layout.historyDatabase}-shm`,
      `${layout.historyDatabase}-journal`,
    ]),
    stat: (path) => {
      const identity = statSync(path);
      return { dev: identity.dev, ino: identity.ino };
    },
    acquireFence: () => acquireStateOpenAdmission(layout.root, "exclusive"),
  });

  return Object.freeze({
    inspectExactOperation(): MigrationAuthorityInspection {
      assertOpen();
      const acceptance = verifyExecutionSource();
      const admission = acquireStateOpenAdmission(layout.root, "shared");
      try {
        admission.assertCurrent();
        migrationAuthority ??= createReviewedV4MigrationAuthority({ stateRoot: layout.root });
        const inspection = migrationAuthority.inspect(authorityBinding(acceptance));
        if (inspection.authorization !== "valid" || inspection.completion !== "valid") return inspection;
        if (!inspection.preState || !inspection.preHistory || !inspection.completedReceipt) {
          return { authorization: "valid", completion: "invalid" };
        }
        try {
          const pair = bindDatabasePair({
            operationId: OPERATION_ID,
            gitRoot: repositoryRoot,
            reviewedWorktreeParent: join(layout.root, "migration-v4", "reviewed-worktrees"),
            sourceIdentity: acceptance.sourceIdentity,
            stateDatabase: layout.database,
            historyDatabase: layout.historyDatabase,
          });
          assertDatabasePairCurrent(pair);
          assertHistoryUnchanged(pair, inspection.preHistory);
          verifyCurrentReviewedV4Database(layout.database);
          verifyRecoveryAuthority({
            pair,
            receipt: inspection.completedReceipt,
            status: inspection.completedReceipt.status as "migrated" | "already_current",
            preState: inspection.preState,
            phase: "current_state",
          });
          admission.assertCurrent();
          return inspection;
        } catch {
          return { authorization: "valid", completion: "invalid" };
        }
      } finally {
        admission.release();
      }
    },
    async migrateExactOperation() {
      assertOpen();
      let acceptance = verifyExecutionSource();
      const bootstrapInput = {
        operationId: OPERATION_ID,
        gitRoot: repositoryRoot,
        reviewedWorktreeParent: join(layout.root, "migration-v4", "reviewed-worktrees"),
        sourceIdentity: acceptance.sourceIdentity,
        stateDatabase: layout.database,
        historyDatabase: layout.historyDatabase,
      };
      const pair = bindDatabasePair(bootstrapInput);
      const binding = authorityBinding(acceptance);
      let completed = false;
      let fence: ReturnType<typeof quiescence.acquireExclusiveWriteFence> | undefined;
      let claim: MigrationAuthorityClaim | undefined;
      try {
        const paths = { stateDatabase: layout.database, historyDatabase: layout.historyDatabase };
        const assertQuiescent = (): void => {
          quiescence.assertServiceInactive(paths);
          quiescence.assertNoOpenDatabaseFds(paths);
        };
        assertQuiescent();
        fence = quiescence.acquireExclusiveWriteFence(paths);
        fence.assertCurrent();
        acceptance = verifyExecutionSource();
        if (acceptance.receiptSha256 !== binding.adoptionSha256 ||
            acceptance.promotionSha256 !== binding.promotionSha256 ||
            canonicalJson(acceptance.sourceIdentity) !== canonicalJson(binding.sourceIdentity)) {
          throw new Error("accepted source identity changed before migration authority issuance");
        }
        migrationAuthority ??= createReviewedV4MigrationAuthority({ stateRoot: layout.root });
        const durableCapability = migrationAuthority.issuer.issue(binding);
        claim = migrationAuthority.consumer.claim(durableCapability, binding);
        assertDatabasePairCurrent(pair);
        claim.assertCurrent();
        fence.assertCurrent();
        verifyExecutionSource();
        assertQuiescent();
        const current = observeLegacyDatabase(layout.database, "state", claim.preState.manifest);
        let status: "migrated" | "already_current";
        let rawReceipt: Record<string, unknown>;
        if (current.userVersion === 4) {
          status = "already_current";
          rawReceipt = claim.completedReceipt ?? { status };
        } else {
          const result = runReviewedV4MigrationKernel({
            stateDatabase: layout.database,
            historyDatabase: layout.historyDatabase,
            repositoryRoot,
            gitRoot: repositoryRoot,
          });
          input.faultInjector?.("after_v4_coordinator_return");
          rawReceipt = receiptForProcess(result);
          status = rawReceipt.status as "migrated" | "already_current";
        }
        fence.assertCurrent();
        assertQuiescent();
        verifyExecutionSource();
        assertDatabasePairCurrent(pair);
        assertHistoryUnchanged(pair, claim.preHistory);
        if (status === "migrated") verifyMigratedDatabaseAtBoundary(layout.database);
        else verifyCurrentReviewedV4Database(layout.database);
        const recovery = verifyRecoveryAuthority({
          pair,
          receipt: rawReceipt,
          status,
          preState: claim.preState,
          phase: status === "migrated" ? "migration_boundary" : "current_state",
        });
        const output = Object.freeze({
          status,
          sourceCommitOid: acceptance.sourceIdentity.commitOid,
          sourceTreeOid: acceptance.sourceIdentity.treeOid,
          importedProgressEvents: 3 as const,
          lastProgressEventSha256: rawReceipt.lastProgressEventSha256 ??
            claim.completedReceipt?.lastProgressEventSha256 ??
            acceptance.sourceIdentity.lastProgressEventSha256,
          backupPath: recovery.backupPath,
          guardPath: recovery.guardPath,
          graphExecution: "disabled" as const,
        });
        claim.complete(claim.completedReceipt ?? output);
        completed = true;
        return output;
      } finally {
        try { if (!completed) claim?.abort(); }
        finally { fence?.release(); }
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      migrationAuthority?.close();
    },
  });
}
