import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, relative } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function realDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error(`${label} must be a real project directory: ${path}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a real project directory: ${path}`);
  }
  return canonical;
}

export class ProjectPolicy {
  private readonly allowedRoots: readonly string[];

  constructor(allowedRoots: readonly string[]) {
    if (allowedRoots.length === 0) throw new Error("at least one allowed project root is required");
    this.allowedRoots = allowedRoots.map((root) => realDirectory(root, "allowed project root"));
  }

  resolve(project: string): string {
    const canonical = realDirectory(project, "project");
    if (!this.allowedRoots.some((root) => isInside(root, canonical))) {
      throw new Error(`project is outside allowed project roots: ${project}`);
    }
    return canonical;
  }
}

export function defaultAllowedProjectRoots(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): readonly string[] {
  const configured = env.AGENT_COLLAB_ALLOWED_ROOTS?.split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return configured?.length ? configured : [userHome];
}
