import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function rejectSymlinkComponents(path: string): void {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`certification path contains a symbolic link: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function canonicalDirectory(path: string): string {
  rejectSymlinkComponents(path);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`certification path is not a directory: ${path}`);
  if (canonical !== resolve(path)) throw new Error(`certification path is not canonical: ${path}`);
  return canonical;
}

export function createCertificationRunRoot(input: {
  runRoot: string;
  protectedRoots: readonly string[];
}): string {
  const requested = resolve(input.runRoot);
  rejectSymlinkComponents(requested);
  const protectedRoots = input.protectedRoots.map((root) => realpathSync(root));
  for (const protectedRoot of protectedRoots) {
    if (inside(protectedRoot, requested) || inside(requested, protectedRoot)) {
      throw new Error("certification run root must be disjoint from project and source repositories");
    }
  }
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const runRoot = canonicalDirectory(requested);
  for (const protectedRoot of protectedRoots) {
    if (inside(protectedRoot, runRoot) || inside(runRoot, protectedRoot)) {
      throw new Error("certification run root must be disjoint from project and source repositories");
    }
  }
  return runRoot;
}

export function requireCertificationRunRoot(runRoot: string): string {
  return canonicalDirectory(runRoot);
}

export function createCertificationSubdirectory(runRoot: string, relativePath: string): string {
  const canonicalRoot = requireCertificationRunRoot(runRoot);
  if (isAbsolute(relativePath) || relativePath === "" || relativePath.split(/[\\/]/u).includes("..")) {
    throw new Error("certification subdirectory must be a non-empty relative path");
  }
  const requested = join(canonicalRoot, relativePath);
  if (!inside(canonicalRoot, requested)) throw new Error("certification subdirectory escapes run root");
  rejectSymlinkComponents(requested);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const canonical = canonicalDirectory(requested);
  if (!inside(canonicalRoot, canonical)) throw new Error("certification subdirectory escapes run root");
  return canonical;
}
