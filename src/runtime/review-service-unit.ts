import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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

const restoreRuntimeMask = (systemctl: SystemctlRunner, cause: unknown): never => {
  const failures: Error[] = [];
  for (const [args, accepted] of [
    [["disable", "--now", REVIEWED_UNIT], new Set([0, 1])],
    [["mask", "--runtime", REVIEWED_UNIT], new Set([0])],
    [["daemon-reload"], new Set([0])],
  ] as const) {
    const result = systemctl(args);
    if (result.status === null || !accepted.has(result.status)) {
      failures.push(new Error(`systemctl ${args.join(" ")} failed with status ${String(result.status)}`));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError([cause, ...failures],
      "review service cutover failed and the runtime mask could not be fully restored");
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
  const unitDirectory = resolve(input.homeDirectory, ".config/systemd/user");
  const destination = join(unitDirectory, REVIEWED_UNIT);
  if (realpathSync(destination) !== destination || sha256(readRegularNoFollow(destination)) !== expected.sha256) {
    throw new Error("installed review service unit does not match the reviewed source bytes");
  }
  const observed = properties(input.systemctl);
  if (existsSync(`${destination}.d`)) {
    throw new Error("installed review service unit retains a user drop-in directory");
  }
  if (input.requireMasked) {
    if (observed.LoadState !== "masked") {
      throw new Error("staged review service unit lost its runtime mask");
    }
    return {
      unitSha256: expected.sha256,
      fragmentPath: destination,
      execStart: `${realpathSync(resolve(input.repositoryRoot))}/scripts/agent-collab-launcher.mjs review-worker`,
      loadState: observed.LoadState,
    };
  }
  if (observed.FragmentPath !== destination || observed.DropInPaths !== "" ||
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
  return realpathSync(backupDirectory);
};

export function stageReviewedWorkerService(input: {
  readonly repositoryRoot: string;
  readonly homeDirectory: string;
  readonly backupDirectory: string;
  readonly systemctl?: SystemctlRunner;
}) {
  const systemctl = input.systemctl ?? defaultSystemctl;
  const expected = expectedUnit(input.repositoryRoot);
  assertLegacyQuarantined(input.homeDirectory, systemctl);
  let backup: string | undefined;
  let loaded: ReturnType<typeof verifyInstalled> | undefined;
  try {
    run(systemctl, ["disable", "--now", REVIEWED_UNIT], new Set([0, 1]));
    assertInactive(systemctl, REVIEWED_UNIT);
    assertReviewedDisabled(systemctl);
    backup = canonicalNewBackup(input.backupDirectory);
    const unitDirectory = resolve(input.homeDirectory, ".config/systemd/user");
    mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(unitDirectory) !== unitDirectory) {
      throw new Error("systemd user unit directory must be canonical");
    }
    const destination = join(unitDirectory, REVIEWED_UNIT);
    if (existsSync(destination)) {
      const prior = lstatSync(destination);
      if (prior.isSymbolicLink()) {
        writeFileSync(join(backup, "previous-unit-symlink-target"), `${readlinkSync(destination)}\n`, { mode: 0o600 });
      } else if (prior.isFile() && prior.nlink === 1) {
        writeFileSync(join(backup, `previous-${REVIEWED_UNIT}`), readRegularNoFollow(destination), { mode: 0o600 });
      } else {
        throw new Error("existing user service unit is not a regular file or mask symlink");
      }
    }
    const dropIns = `${destination}.d`;
    if (existsSync(dropIns)) {
      const dropInStat = lstatSync(dropIns);
      if (!dropInStat.isDirectory() || dropInStat.isSymbolicLink()) {
        throw new Error("existing service drop-in path is not a real directory");
      }
      renameSync(dropIns, join(backup, `previous-${REVIEWED_UNIT}.d`));
    }
    const durability = new StateFileDurability({ stateRoot: unitDirectory });
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
    run(systemctl, ["daemon-reload"]);
    loaded = verifyInstalled({ ...input, systemctl, requireMasked: false });
    assertReviewedDisabled(systemctl);
    run(systemctl, ["mask", "--runtime", REVIEWED_UNIT]);
    run(systemctl, ["daemon-reload"]);
    assertInactive(systemctl, REVIEWED_UNIT);
    verifyInstalled({ ...input, systemctl, requireMasked: true });
  } catch (error) {
    restoreRuntimeMask(systemctl, error);
  }
  if (!backup || !loaded) throw new Error("review service unit was not staged and verified before masking");
  return Object.freeze({
    protocol: "agent-collab-reviewed-worker-unit-stage/v1" as const,
    status: "staged_masked" as const,
    backupDirectory: backup,
    ...loaded,
    loadState: "masked" as const,
  });
}

export function activateReviewedWorkerService(input: {
  readonly repositoryRoot: string;
  readonly homeDirectory: string;
  readonly systemctl?: SystemctlRunner;
}) {
  const systemctl = input.systemctl ?? defaultSystemctl;
  assertLegacyQuarantined(input.homeDirectory, systemctl);
  assertInactive(systemctl, REVIEWED_UNIT);
  run(systemctl, ["daemon-reload"]);
  verifyInstalled({ ...input, systemctl, requireMasked: true });
  let loaded: ReturnType<typeof verifyInstalled> | undefined;
  try {
    run(systemctl, ["unmask", "--runtime", REVIEWED_UNIT]);
    loaded = verifyInstalled({ ...input, systemctl, requireMasked: false });
    assertReviewedDisabled(systemctl);
    run(systemctl, ["enable", "--now", REVIEWED_UNIT]);
    const active = run(systemctl, ["is-active", REVIEWED_UNIT]).stdout.trim();
    if (active !== "active") throw new Error("review worker service did not become active");
    const enabled = run(systemctl, ["is-enabled", REVIEWED_UNIT]).stdout.trim();
    if (enabled !== "enabled") throw new Error("review worker service did not become persistently enabled");
  } catch (error) {
    restoreRuntimeMask(systemctl, error);
  }
  if (!loaded) throw new Error("review service unit was not verified before activation");
  return Object.freeze({
    protocol: "agent-collab-reviewed-worker-unit-activation/v1" as const,
    status: "active" as const,
    activationId: randomUUID(),
    ...loaded,
  });
}
