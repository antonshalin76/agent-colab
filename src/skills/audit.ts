import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type AgentId = "grok" | "claude" | "codex";

export interface SkillManifestEntry {
  name: string;
  sha256: string;
}

interface AgentSkillAudit {
  resolvedRoot: string | null;
  manifest: SkillManifestEntry[];
}

type BrokenLink =
  | { scope: "canonical"; path: string; target: string }
  | { scope: "agent"; agent: AgentId; path: string; target: string };

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return filesUnder(root, path);
    return entry.isFile() ? [relative(root, path)] : [];
  });
}

function skillHash(root: string): string {
  const hash = createHash("sha256");
  for (const path of filesUnder(root).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildManifest(root: string): SkillManifestEntry[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry): SkillManifestEntry[] => {
      const path = join(root, entry.name);
      try {
        const resolved = realpathSync(path);
        if (!statSync(resolved).isDirectory()) return [];
        return [{ name: entry.name, sha256: skillHash(resolved) }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function absoluteTarget(path: string): string {
  const target = readlinkSync(path);
  return resolve(dirname(path), target);
}

function canonicalBrokenLinks(root: string, current = root): BrokenLink[] {
  const links: BrokenLink[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      if (!existsSync(path)) links.push({ scope: "canonical", path, target: absoluteTarget(path) });
    } else if (entry.isDirectory()) {
      links.push(...canonicalBrokenLinks(root, path));
    }
  }
  return links;
}

export function auditSharedSkills(input: {
  canonicalRoot: string;
  agentRoots: Readonly<Record<AgentId, string>>;
}): {
  canonicalRoot: string;
  agents: Record<AgentId, AgentSkillAudit>;
  consistent: boolean;
  brokenLinks: BrokenLink[];
} {
  const canonicalRoot = realpathSync(input.canonicalRoot);
  const brokenLinks = canonicalBrokenLinks(canonicalRoot);
  const agents = {} as Record<AgentId, AgentSkillAudit>;
  for (const agent of ["grok", "claude", "codex"] as const) {
    const configuredRoot = input.agentRoots[agent];
    try {
      const resolvedRoot = realpathSync(configuredRoot);
      agents[agent] = { resolvedRoot, manifest: buildManifest(resolvedRoot) };
    } catch {
      agents[agent] = { resolvedRoot: null, manifest: [] };
      brokenLinks.push({
        scope: "agent",
        agent,
        path: configuredRoot,
        target: (() => {
          try { return lstatSync(configuredRoot).isSymbolicLink() ? absoluteTarget(configuredRoot) : configuredRoot; }
          catch { return configuredRoot; }
        })(),
      });
    }
  }
  const manifestsMatch = [agents.grok, agents.claude, agents.codex]
    .every((agent) => JSON.stringify(agent.manifest) === JSON.stringify(agents.grok.manifest));
  const rootsMatch = [agents.grok, agents.claude, agents.codex]
    .every((agent) => agent.resolvedRoot === canonicalRoot);
  return {
    canonicalRoot,
    agents,
    consistent: brokenLinks.length === 0 && rootsMatch && manifestsMatch,
    brokenLinks,
  };
}
