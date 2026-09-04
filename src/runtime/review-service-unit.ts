import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { StateFileDurability } from "../store/state-file-durability.js";
import { runUserSystemctl } from "./systemd-user.js";

const LEGACY_UNIT = "agent-collab.service";
const REVIEWED_UNIT = "agent-collab-reviewed.service";

export interface SystemctlResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemctlRunner = (args: readonly string[]) => SystemctlResult;

const defaultSystemctl: SystemctlRunner = (args) => {
  return runUserSystemctl(args);
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const run = (systemctl: SystemctlRunner, args: readonly string[], accepted = new Set([0])): SystemctlResult => {
  const result = systemctl(args);
  if (result.status === null || !accepted.has(result.status)) {
    throw new Error(`systemctl ${args.join(" ")} failed with status ${String(result.status)}`);
  }
  return result;
};

const reviewedUnitPaths = (homeDirectory: string) => ({
  configDirectory: resolve(homeDirectory, ".config/systemd/user"),
  dataDirectory: resolve(homeDirectory, ".local/share/systemd/user"),
  maskPath: resolve(homeDirectory, ".config/systemd/user", REVIEWED_UNIT),
  unitPath: resolve(homeDirectory, ".local/share/systemd/user", REVIEWED_UNIT),
});

const assertDefaultXdgUnitPaths = (homeDirectory: string): void => {
  const expectedConfig = resolve(homeDirectory, ".config");
  const expectedData = resolve(homeDirectory, ".local/share");
  if ((process.env.XDG_CONFIG_HOME && resolve(process.env.XDG_CONFIG_HOME) !== expectedConfig) ||
      (process.env.XDG_DATA_HOME && resolve(process.env.XDG_DATA_HOME) !== expectedData)) {
    throw new Error("review service cutover requires the default HOME-scoped XDG config and data paths");
  }
};

const assertCanonicalDirectory = (path: string, label: string): void => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`${label} must be a canonical real directory`);
  }
};

const fsyncDirectory = (path: string): void => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
};

const installPersistentReviewedMask = (homeDirectory: string): void => {
  const { configDirectory, maskPath } = reviewedUnitPaths(homeDirectory);
  assertCanonicalDirectory(configDirectory, "systemd user configuration directory");
  const temporary = join(configDirectory, `.${REVIEWED_UNIT}.${randomUUID()}.mask`);
  try {
    symlinkSync("/dev/null", temporary);
    renameSync(temporary, maskPath);
    fsyncDirectory(configDirectory);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const installed = lstatSync(maskPath);
  if (!installed.isSymbolicLink() || readlinkSync(maskPath) !== "/dev/null") {
    throw new Error("review service persistent activation mask was not installed");
  }
};

const withCutoverLock = <T>(homeDirectory: string, operation: () => T): T => {
  assertDefaultXdgUnitPaths(homeDirectory);
  const { configDirectory } = reviewedUnitPaths(homeDirectory);
  assertCanonicalDirectory(configDirectory, "systemd user configuration directory");
  const durability = new StateFileDurability({ stateRoot: configDirectory });
  try {
    return durability.withExclusiveLock({ lockBasename: "agent-collab-reviewed.cutover.lock" }, operation);
  } finally {
    durability.close();
  }
};

const restorePersistentMask = (
  homeDirectory: string,
  systemctl: SystemctlRunner,
  cause: unknown,
): never => {
  const failures: Error[] = [];
  const commands = [
    [["disable", "--now", REVIEWED_UNIT], new Set([0, 1])],
    [["unmask", "--runtime", REVIEWED_UNIT], new Set([0, 1])],
  ] as const;
  for (const [args, accepted] of commands) {
    const result = systemctl(args);
    if (result.status === null || !accepted.has(result.status)) {
      failures.push(new Error(`systemctl ${args.join(" ")} failed with status ${String(result.status)}`));
    }
  }
  try { installPersistentReviewedMask(homeDirectory); }
  catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))); }
  const reloaded = systemctl(["daemon-reload"]);
  if (reloaded.status !== 0) {
    failures.push(new Error(`systemctl daemon-reload failed with status ${String(reloaded.status)}`));
  }
  try {
    assertInactive(systemctl, REVIEWED_UNIT);
    assertReviewedDisabled(systemctl);
    const observed = properties(systemctl);
    if (observed.LoadState !== "masked" || observed.UnitFileState !== "masked") {
      throw new Error("review service manager did not retain the persistent activation mask");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (failures.length > 0) {
    throw new AggregateError([cause, ...failures],
      "review service cutover failed and the persistent activation mask could not be fully restored");
  }
  throw cause;
};

const assertInactive = (systemctl: SystemctlRunner, unit: string): void => {
  const state = run(systemctl, ["is-active", unit], new Set([0, 3, 4])).stdout.trim();
  if (state === "active") throw new Error("review worker service must be inactive during unit cutover");
  if (!new Set(["inactive", "failed", "unknown"]).has(state)) {
    throw new Error(`review worker service state is not safely observable: ${state || "empty"}`);
  }
};

const readRegularNoFollow = (path: string): Buffer => {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    const linked = lstatSync(path);
    const expectedUid = process.getuid?.();
    if (!before.isFile() || !linked.isFile() || linked.isSymbolicLink() || before.nlink !== 1 ||
        before.dev !== linked.dev || before.ino !== linked.ino ||
        (expectedUid !== undefined && before.uid !== expectedUid)) {
      throw new Error("service unit source is not an owner-owned regular no-follow file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("service unit source changed while reading");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
};

const expectedUnit = (repositoryRoot: string): { path: string; bytes: Buffer; sha256: string } => {
  const root = realpathSync(resolve(repositoryRoot));
  if (root !== resolve(repositoryRoot)) throw new Error("reviewed repository root must be canonical");
  const path = join(root, "systemd", LEGACY_UNIT);
  const bytes = readRegularNoFollow(path);
  const text = bytes.toString("utf8");
  if (!text.includes("scripts/agent-collab-launcher.mjs review-worker") ||
      /(?:dist\/cli\.js|agent-collab-launcher\.mjs) worker(?:\s|$)/u.test(text)) {
    throw new Error("reviewed service unit does not contain the exact review-only source launcher");
  }
  return { path, bytes, sha256: sha256(bytes) };
};

const properties = (systemctl: SystemctlRunner, unit = REVIEWED_UNIT): Record<string, string> => {
  const output = run(systemctl, [
    "show", unit,
    "--property=FragmentPath",
    "--property=ExecStart",
    "--property=DropInPaths",
    "--property=LoadState",
    "--property=ActiveState",
    "--property=UnitFileState",
  ]).stdout;
  return Object.fromEntries(output.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
};

const assertLegacyQuarantined = (homeDirectory: string, systemctl: SystemctlRunner): void => {
  const legacyPath = resolve(homeDirectory, ".config/systemd/user", LEGACY_UNIT);
  const legacy = lstatSync(legacyPath);
  if (!legacy.isSymbolicLink() || readlinkSync(legacyPath) !== "/dev/null") {
    throw new Error("legacy agent-collab.service must remain a persistent /dev/null mask");
  }
  assertInactive(systemctl, LEGACY_UNIT);
  if (properties(systemctl, LEGACY_UNIT).LoadState !== "masked") {
    throw new Error("legacy agent-collab.service is not masked in the service manager");
  }
};

const assertReviewedDisabled = (systemctl: SystemctlRunner): void => {
  const state = run(systemctl, ["is-enabled", REVIEWED_UNIT], new Set([0, 1, 3, 4])).stdout.trim();
  if (!new Set(["disabled", "masked", "not-found"]).has(state)) {
    throw new Error(`review worker service is not disabled: ${state || "empty"}`);
  }
};

const verifyInstalled = (input: {
  repositoryRoot: string;
  homeDirectory: string;
  systemctl: SystemctlRunner;
  requireMasked: boolean;
}): { unitSha256: string; fragmentPath: string; execStart: string; loadState: string } => {
  const expected = expectedUnit(input.repositoryRoot);
  const { configDirectory, dataDirectory, maskPath, unitPath: destination } = reviewedUnitPaths(input.homeDirectory);
  if (realpathSync(destination) !== destination || sha256(readRegularNoFollow(destination)) !== expected.sha256) {
    throw new Error("installed review service unit does not match the reviewed source bytes");
  }
  const observed = properties(input.systemctl);
  if (existsSync(`${join(configDirectory, REVIEWED_UNIT)}.d`) ||
      existsSync(`${join(dataDirectory, REVIEWED_UNIT)}.d`)) {
    throw new Error("installed review service unit retains a user drop-in directory");
  }
  if (input.requireMasked) {
    const mask = lstatSync(maskPath);
    if (!mask.isSymbolicLink() || readlinkSync(maskPath) !== "/dev/null" ||
        observed.LoadState !== "masked" || observed.UnitFileState !== "masked") {
      throw new Error("staged review service unit lost its persistent activation mask");
    }
    return {
      unitSha256: expected.sha256,
      fragmentPath: destination,
      execStart: `${realpathSync(resolve(input.repositoryRoot))}/scripts/agent-collab-launcher.mjs review-worker`,
      loadState: observed.LoadState,
    };
  }
  if (existsSync(maskPath) || observed.FragmentPath !== destination || observed.DropInPaths !== "" ||
      !observed.ExecStart?.includes(`${realpathSync(resolve(input.repositoryRoot))}/scripts/agent-collab-launcher.mjs review-worker`) ||
      /dist\/cli\.js|agent-collab-launcher\.mjs worker(?:\s|;|$)/u.test(observed.ExecStart ?? "")) {
    throw new Error("effective systemd unit is not the exact review-only source launcher without drop-ins");
  }
  if (observed.LoadState !== "loaded") {
    throw new Error("effective review service unit load state is invalid");
  }
  return {
    unitSha256: expected.sha256,
    fragmentPath: observed.FragmentPath,
    execStart: observed.ExecStart,
    loadState: observed.LoadState,
  };
};

const canonicalNewBackup = (backupDirectory: string): string => {
  if (!isAbsolute(backupDirectory) || resolve(backupDirectory) !== backupDirectory || existsSync(backupDirectory)) {
    throw new Error("service unit backup directory must be an absolute nonexistent path");
  }
  const parent = resolve(backupDirectory, "..");
  if (realpathSync(parent) !== parent) throw new Error("service unit backup parent must be canonical");
  mkdirSync(backupDirectory, { mode: 0o700 });
  chmodSync(backupDirectory, 0o700);
  fsyncDirectory(parent);
  return realpathSync(backupDirectory);
};

const fsyncTree = (path: string): void => {
  const linked = lstatSync(path);
  if (linked.isDirectory() && !linked.isSymbolicLink()) {
    for (const entry of readdirSync(path)) fsyncTree(join(path, entry));
    fsyncDirectory(path);
    return;
  }
  if (!linked.isFile() || linked.isSymbolicLink()) {
    throw new Error("service unit backup tree contains an unsupported entry");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
};

export function stageReviewedWorkerService(input: {
  readonly repositoryRoot: string;
  readonly homeDirectory: string;
  readonly backupDirectory: string;
  readonly systemctl?: SystemctlRunner;
  readonly faultInjector?: (point: "after_backup_durable" | "after_reviewed_disabled" | "after_persistent_mask") => void;
}) {
  return withCutoverLock(input.homeDirectory, () => stageReviewedWorkerServiceLocked(input));
}

const stageReviewedWorkerServiceLocked = (input: {
  readonly repositoryRoot: string;
  readonly homeDirectory: string;
  readonly backupDirectory: string;
  readonly systemctl?: SystemctlRunner;
  readonly faultInjector?: (point: "after_backup_durable" | "after_reviewed_disabled" | "after_persistent_mask") => void;
}) => {
  const systemctl = input.systemctl ?? defaultSystemctl;
  const expected = expectedUnit(input.repositoryRoot);
  assertLegacyQuarantined(input.homeDirectory, systemctl);
  let backup: string | undefined;
  let loaded: ReturnType<typeof verifyInstalled> | undefined;
  try {
    backup = canonicalNewBackup(input.backupDirectory);
    const { configDirectory, dataDirectory, maskPath, unitPath: destination } = reviewedUnitPaths(input.homeDirectory);
    assertCanonicalDirectory(configDirectory, "systemd user configuration directory");
    assertCanonicalDirectory(dataDirectory, "systemd user data directory");
    if (existsSync(maskPath)) {
      const prior = lstatSync(maskPath);
      if (prior.isSymbolicLink()) {
        writeFileSync(join(backup, "previous-config-unit-symlink-target"), `${readlinkSync(maskPath)}\n`, { mode: 0o600 });
      } else if (prior.isFile() && prior.nlink === 1) {
        writeFileSync(join(backup, `previous-config-${REVIEWED_UNIT}`), readRegularNoFollow(maskPath), { mode: 0o600 });
      } else {
        throw new Error("existing reviewed service configuration entry is not a regular file or mask symlink");
      }
    }
    if (existsSync(destination)) {
      const prior = lstatSync(destination);
      if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1) {
        throw new Error("existing reviewed service data unit is not a regular file");
      }
      writeFileSync(join(backup, `previous-data-${REVIEWED_UNIT}`), readRegularNoFollow(destination), { mode: 0o600 });
    }
    for (const [dropIns, backupName] of [
      [`${maskPath}.d`, `snapshot-config-${REVIEWED_UNIT}.d`],
      [`${destination}.d`, `snapshot-data-${REVIEWED_UNIT}.d`],
    ] as const) {
      if (!existsSync(dropIns)) continue;
      const dropInStat = lstatSync(dropIns);
      if (!dropInStat.isDirectory() || dropInStat.isSymbolicLink()) {
        throw new Error("existing service drop-in path is not a real directory");
      }
      cpSync(dropIns, join(backup, backupName), { recursive: true, errorOnExist: true, preserveTimestamps: true });
    }
    fsyncTree(backup);
    input.faultInjector?.("after_backup_durable");
    run(systemctl, ["disable", "--now", REVIEWED_UNIT], new Set([0, 1]));
    assertInactive(systemctl, REVIEWED_UNIT);
    input.faultInjector?.("after_reviewed_disabled");
    installPersistentReviewedMask(input.homeDirectory);
    input.faultInjector?.("after_persistent_mask");
    for (const [dropIns, backupName] of [
      [`${maskPath}.d`, `removed-config-${REVIEWED_UNIT}.d`],
      [`${destination}.d`, `removed-data-${REVIEWED_UNIT}.d`],
    ] as const) {
      if (!existsSync(dropIns)) continue;
      renameSync(dropIns, join(backup, backupName));
      fsyncDirectory(dirname(dropIns));
      fsyncDirectory(backup);
    }
    fsyncTree(backup);
    const durability = new StateFileDurability({ stateRoot: dataDirectory });
    try {
      const installed = durability.atomicReplace({
        relativePath: REVIEWED_UNIT,
        bytes: expected.bytes,
        faultPointPrefix: "service_unit",
      });
      installed.close();
    } finally {
      durability.close();
    }
    run(systemctl, ["unmask", "--runtime", REVIEWED_UNIT], new Set([0, 1]));
    run(systemctl, ["daemon-reload"]);
    assertInactive(systemctl, REVIEWED_UNIT);
    loaded = verifyInstalled({ ...input, systemctl, requireMasked: true });
    assertReviewedDisabled(systemctl);
  } catch (error) {
    restorePersistentMask(input.homeDirectory, systemctl, error);
  }
  if (!backup || !loaded) throw new Error("review service unit was not staged and verified before masking");
  return Object.freeze({
    protocol: "agent-collab-reviewed-worker-unit-stage/v1" as const,
    status: "staged_masked" as const,
    backupDirectory: backup,
    ...loaded,
    loadState: "masked" as const,
  });
};

export function activateReviewedWorkerService(input: {
  readonly repositoryRoot: string;
  readonly homeDirectory: string;
  readonly systemctl?: SystemctlRunner;
}) {
  return withCutoverLock(input.homeDirectory, () => activateReviewedWorkerServiceLocked(input));
}

const activateReviewedWorkerServiceLocked = (input: {
  readonly repositoryRoot: string;
  readonly homeDirectory: string;
  readonly systemctl?: SystemctlRunner;
}) => {
  const systemctl = input.systemctl ?? defaultSystemctl;
  assertLegacyQuarantined(input.homeDirectory, systemctl);
  let loaded: ReturnType<typeof verifyInstalled> | undefined;
  try {
    assertInactive(systemctl, REVIEWED_UNIT);
    run(systemctl, ["daemon-reload"]);
    verifyInstalled({ ...input, systemctl, requireMasked: true });
    run(systemctl, ["unmask", REVIEWED_UNIT]);
    run(systemctl, ["daemon-reload"]);
    loaded = verifyInstalled({ ...input, systemctl, requireMasked: false });
    assertReviewedDisabled(systemctl);
    run(systemctl, ["enable", "--now", REVIEWED_UNIT]);
    const active = run(systemctl, ["is-active", REVIEWED_UNIT]).stdout.trim();
    if (active !== "active") throw new Error("review worker service did not become active");
    const enabled = run(systemctl, ["is-enabled", REVIEWED_UNIT]).stdout.trim();
    if (enabled !== "enabled") throw new Error("review worker service did not become persistently enabled");
  } catch (error) {
    restorePersistentMask(input.homeDirectory, systemctl, error);
  }
  if (!loaded) throw new Error("review service unit was not verified before activation");
  return Object.freeze({
    protocol: "agent-collab-reviewed-worker-unit-activation/v1" as const,
    status: "active" as const,
    activationId: randomUUID(),
    ...loaded,
  });
};
