import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface StateLayout { root: string; database: string; historyDatabase: string; socket?: never }
export interface StateV4MigrationLayout {
  root: string;
  backupDirectory: string;
  guardDirectory: string;
  lockPath: string;
  activeGuardDescriptorPath: string;
}
export interface StateRootLease {
  readonly canonicalRoot: string;
  readonly pinnedRoot: string;
  assertCurrent(): void;
  release(): void;
}

export const GRAPH_EXECUTION_MODE = "disabled" as const;

const assertRegularFile = (path: string, label: string): void => {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`existing ${label} database is required for compatibility runtime`);
  }
};

export function openExistingStateLayout(root: string): StateLayout {
  const requestedRoot = resolve(root);
  if (!existsSync(requestedRoot) || !lstatSync(requestedRoot).isDirectory() ||
      lstatSync(requestedRoot).isSymbolicLink()) {
    throw new Error("existing state root directory is required for compatibility runtime");
  }
  const canonicalRoot = realpathSync(requestedRoot);
  const database = resolve(canonicalRoot, "collaboration.db");
  const historyDatabase = resolve(canonicalRoot, "history.db");
  assertRegularFile(database, "state");
  assertRegularFile(historyDatabase, "history");
  return { root: canonicalRoot, database, historyDatabase };
}

export function ensureStateLayout(root: string): StateLayout {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const database = resolve(root, "collaboration.db");
  if (!existsSync(database)) closeSync(openSync(database, "wx", 0o600));
  chmodSync(database, 0o600);
  const historyDatabase = resolve(root, "history.db");
  if (!existsSync(historyDatabase)) closeSync(openSync(historyDatabase, "wx", 0o600));
  chmodSync(historyDatabase, 0o600);
  return { root: realpathSync(root), database, historyDatabase };
}

export function resolveStatePath(root: string, candidate: string): string {
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, candidate);
  const rel = relative(canonicalRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("state path is outside the private state root");
  }
  let cursor = canonicalRoot;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("state path crosses a symlink");
  }
  return target;
}

export function ensureStateV4MigrationLayout(root: string): StateV4MigrationLayout {
  const canonicalRoot = realpathSync(root);
  const migrationRoot = resolveStatePath(canonicalRoot, "migration-v4");
  const backupDirectory = resolveStatePath(canonicalRoot, "migration-v4/backups");
  const guardDirectory = resolveStatePath(canonicalRoot, "migration-guard");
  for (const directory of [migrationRoot, backupDirectory, guardDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) {
      throw new Error("state-v4 migration path must be a real directory");
    }
    chmodSync(directory, 0o700);
  }
  return {
    root: canonicalRoot,
    backupDirectory,
    guardDirectory,
    lockPath: resolveStatePath(canonicalRoot, "migration-v4/migration.lock"),
    activeGuardDescriptorPath: resolveStatePath(canonicalRoot, "migration-v4/active-restore-guard.json"),
  };
}

export function acquireStateRootLease(
  root: string,
  mode: "shared" | "exclusive",
): StateRootLease {
  const requested = resolve(root);
  if (!existsSync(requested) || !lstatSync(requested).isDirectory() || lstatSync(requested).isSymbolicLink()) {
    throw new Error("state root must be an existing real directory");
  }
  const canonical = realpathSync(requested);
  const before = statSync(canonical);
  const descriptor = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const locked = spawnSync("/usr/bin/flock", ["-w", "5", mode === "shared" ? "-s" : "-x", "3"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", descriptor],
  });
  if (locked.error || locked.status !== 0) {
    closeSync(descriptor);
    throw new Error(`state root fence busy: ${locked.error?.message ?? locked.stderr ?? "flock denied"}`);
  }
  const after = fstatSync(descriptor);
  const current = statSync(canonical);
  if (after.dev !== before.dev || after.ino !== before.ino ||
      current.dev !== before.dev || current.ino !== before.ino) {
    closeSync(descriptor);
    throw new Error("state root identity changed while acquiring its fence");
  }
  const assertCurrent = (): void => {
    if (!existsSync(canonical) || !lstatSync(canonical).isDirectory() || lstatSync(canonical).isSymbolicLink()) {
      throw new Error("state root pathname changed while its fence was held");
    }
    const pinned = fstatSync(descriptor);
    const pathname = statSync(canonical);
    if (pinned.dev !== before.dev || pinned.ino !== before.ino ||
        pathname.dev !== before.dev || pathname.ino !== before.ino) {
      throw new Error("state root identity changed while its fence was held");
    }
  };
  let released = false;
  return Object.freeze({
    canonicalRoot: canonical,
    pinnedRoot: `/proc/self/fd/${descriptor}`,
    assertCurrent,
    release: () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    },
  });
}

export function acquireStateRootLock(
  root: string,
  mode: "shared" | "exclusive",
): () => void {
  const lease = acquireStateRootLease(root, mode);
  return lease.release;
}

export function withStateRootLock<T>(
  root: string,
  mode: "shared" | "exclusive",
  operation: () => T,
): T {
  const release = acquireStateRootLock(root, mode);
  try { return operation(); }
  finally { release(); }
}
