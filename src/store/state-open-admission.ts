import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

export interface StateOpenAdmission {
  readonly canonicalRoot: string;
  assertCurrent(): void;
  release(): void;
}

const LOCK_FILE = ".state-open-admission.lock";

export function acquireStateOpenAdmission(
  root: string,
  mode: "shared" | "exclusive",
): StateOpenAdmission {
  const requested = resolve(root);
  if (!existsSync(requested) || !lstatSync(requested).isDirectory() || lstatSync(requested).isSymbolicLink()) {
    throw new Error("state open admission requires an existing real state root");
  }
  const canonicalRoot = realpathSync(requested);
  if (canonicalRoot !== requested) throw new Error("state open admission root aliases are forbidden");
  const rootIdentity = statSync(canonicalRoot);
  const lockPath = join(canonicalRoot, LOCK_FILE);
  const descriptor = openSync(
    lockPath,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    chmodSync(lockPath, 0o600);
    const link = lstatSync(lockPath);
    const lockIdentity = fstatSync(descriptor);
    if (!link.isFile() || link.isSymbolicLink() || link.nlink !== 1 ||
        link.dev !== lockIdentity.dev || link.ino !== lockIdentity.ino) {
      throw new Error("state open admission lock identity is invalid");
    }
    const locked = spawnSync(
      "/usr/bin/flock",
      ["-w", "5", mode === "shared" ? "-s" : "-x", "3"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe", descriptor] },
    );
    if (locked.error || locked.status !== 0) {
      throw new Error(`state open admission busy: ${locked.error?.message ?? locked.stderr ?? "flock denied"}`);
    }
    const assertCurrent = (): void => {
      if (!existsSync(canonicalRoot) || !lstatSync(canonicalRoot).isDirectory() ||
          lstatSync(canonicalRoot).isSymbolicLink() || realpathSync(canonicalRoot) !== canonicalRoot) {
        throw new Error("state open admission root changed while held");
      }
      const currentRoot = statSync(canonicalRoot);
      if (currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino) {
        throw new Error("state open admission root identity changed while held");
      }
      if (!existsSync(lockPath) || lstatSync(lockPath).isSymbolicLink() || !lstatSync(lockPath).isFile() ||
          lstatSync(lockPath).nlink !== 1) {
        throw new Error("state open admission lock pathname changed while held");
      }
      const pinnedLock = fstatSync(descriptor);
      const currentLock = statSync(lockPath);
      if (pinnedLock.dev !== lockIdentity.dev || pinnedLock.ino !== lockIdentity.ino ||
          currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino) {
        throw new Error("state open admission lock identity changed while held");
      }
    };
    assertCurrent();
    let released = false;
    return Object.freeze({
      canonicalRoot,
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        closeSync(descriptor);
      },
    });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
