import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface StateLayout { root: string; database: string; historyDatabase: string; socket?: never }

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
