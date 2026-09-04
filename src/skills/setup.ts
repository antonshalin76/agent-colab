import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ReviewHarnessId = "grok" | "claude" | "codex";

export interface ReviewSkillLinkResult {
  readonly agent: ReviewHarnessId;
  readonly path: string;
  readonly status: "created" | "already_current";
}

const REQUIRED_REVIEW_SKILLS = ["agent-collaboration"] as const;

function requireCanonicalSkillsRoot(path: string): string {
  const requested = resolve(path);
  const canonical = realpathSync(requested);
  const stat = lstatSync(canonical);
  if (canonical !== requested || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("canonical shared skills root must be a real canonical directory");
  }
  for (const skill of REQUIRED_REVIEW_SKILLS) {
    const instruction = join(canonical, skill, "SKILL.md");
    if (!existsSync(instruction) || !lstatSync(instruction).isFile() ||
        readFileSync(instruction).length === 0) {
      throw new Error(`canonical shared skills root is missing required skill: ${skill}`);
    }
  }
  return canonical;
}

export function linkReviewHarnessSkills(input: {
  readonly canonicalRoot: string;
  readonly agentRoots: Readonly<Record<ReviewHarnessId, string>>;
  readonly agents: readonly ReviewHarnessId[];
}): readonly ReviewSkillLinkResult[] {
  const canonicalRoot = requireCanonicalSkillsRoot(input.canonicalRoot);
  if (input.agents.length === 0 || new Set(input.agents).size !== input.agents.length) {
    throw new Error("review skills link requires a nonempty unique harness list");
  }
  return input.agents.map((agent) => {
    const destination = resolve(input.agentRoots[agent]);
    if (existsSync(destination)) {
      const stat = lstatSync(destination);
      if (!stat.isSymbolicLink() || realpathSync(destination) !== canonicalRoot) {
        throw new Error(`review skills destination conflicts for ${agent}: ${destination}`);
      }
      return { agent, path: destination, status: "already_current" as const };
    }
    try {
      if (lstatSync(destination).isSymbolicLink()) {
        throw new Error(`review skills destination is a broken link for ${agent}: ${destination}`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    symlinkSync(canonicalRoot, destination, "dir");
    return { agent, path: destination, status: "created" as const };
  });
}
