import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSharedSkills } from "../src/skills/audit.js";
import { linkReviewHarnessSkills } from "../src/skills/setup.js";
import { inspectReviewReadiness } from "../src/app/review-readiness-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-skills-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, name: string, instruction: string): void {
  const skill = join(root, name);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), instruction, { mode: 0o600 });
}

function collectFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    if (entry.isDirectory()) return collectFiles(root, path);
    return entry.isFile() ? [relative(root, path)] : [];
  });
}

function skillHash(canonicalRoot: string, name: string): string {
  const root = join(canonicalRoot, name);
  const hash = createHash("sha256");
  for (const path of collectFiles(root).sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

describe("BDD-2/12 canonical shared skills", () => {
  it("resolves both agents to one canonical root with exact per-skill hashes", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const grokRoot = join(root, "grok-skills");
    const claudeRoot = join(root, "claude-skills");
    const codexRoot = join(root, "codex-skills");
    mkdirSync(canonicalRoot);
    writeSkill(canonicalRoot, "alpha", "# Alpha\n\nFirst contract.\n");
    writeSkill(canonicalRoot, "beta", "# Beta\n\nSecond contract.\n");
    symlinkSync(canonicalRoot, grokRoot, "dir");
    symlinkSync(canonicalRoot, claudeRoot, "dir");
    symlinkSync(canonicalRoot, codexRoot, "dir");

    const result = auditSharedSkills({
      canonicalRoot,
      agentRoots: { grok: grokRoot, claude: claudeRoot, codex: codexRoot },
    });
    const manifest = [
      { name: "alpha", sha256: skillHash(canonicalRoot, "alpha") },
      { name: "beta", sha256: skillHash(canonicalRoot, "beta") },
    ];
    expect(result).toEqual({
      canonicalRoot: realpathSync(canonicalRoot),
      agents: {
        grok: { resolvedRoot: realpathSync(canonicalRoot), manifest },
        claude: { resolvedRoot: realpathSync(canonicalRoot), manifest },
        codex: { resolvedRoot: realpathSync(canonicalRoot), manifest },
      },
      consistent: true,
      brokenLinks: [],
    });
  });

  it("publishes a canonical update to both agents with the same new exact hash", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const grokRoot = join(root, "grok-skills");
    const claudeRoot = join(root, "claude-skills");
    const codexRoot = join(root, "codex-skills");
    mkdirSync(canonicalRoot);
    writeSkill(canonicalRoot, "shared", "version one\n");
    symlinkSync(canonicalRoot, grokRoot, "dir");
    symlinkSync(canonicalRoot, claudeRoot, "dir");
    symlinkSync(canonicalRoot, codexRoot, "dir");
    const options = { canonicalRoot, agentRoots: { grok: grokRoot, claude: claudeRoot, codex: codexRoot } } as const;
    const before = auditSharedSkills(options);

    writeFileSync(join(canonicalRoot, "shared", "SKILL.md"), "version two\n", { mode: 0o600 });
    const after = auditSharedSkills(options);
    const expected = skillHash(canonicalRoot, "shared");

    expect(before.agents.grok.manifest[0]?.sha256).not.toBe(expected);
    expect(after.agents.grok.manifest).toEqual([{ name: "shared", sha256: expected }]);
    expect(after.agents.claude.manifest).toEqual([{ name: "shared", sha256: expected }]);
    expect(after.agents.codex.manifest).toEqual([{ name: "shared", sha256: expected }]);
    expect(after.consistent).toBe(true);
  });

  it("attests a valid symlinked skill and detects target-content drift", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const externalRoot = join(root, "external-skill");
    const grokRoot = join(root, "grok-skills");
    const claudeRoot = join(root, "claude-skills");
    const codexRoot = join(root, "codex-skills");
    mkdirSync(canonicalRoot); mkdirSync(externalRoot);
    writeFileSync(join(externalRoot, "SKILL.md"), "version one\n", { mode: 0o600 });
    symlinkSync(externalRoot, join(canonicalRoot, "linked"), "dir");
    symlinkSync(canonicalRoot, grokRoot, "dir"); symlinkSync(canonicalRoot, claudeRoot, "dir");
    symlinkSync(canonicalRoot, codexRoot, "dir");
    const options = { canonicalRoot, agentRoots: { grok: grokRoot, claude: claudeRoot, codex: codexRoot } } as const;
    const before = auditSharedSkills(options);
    expect(before.consistent).toBe(true);
    expect(before.agents.grok.manifest.map((entry) => entry.name)).toEqual(["linked"]);
    writeFileSync(join(externalRoot, "SKILL.md"), "version two\n", { mode: 0o600 });
    const after = auditSharedSkills(options);
    expect(after.consistent).toBe(true);
    expect(after.agents.grok.manifest[0]?.sha256).not.toBe(before.agents.grok.manifest[0]?.sha256);
  });

  it("reports canonical and agent-root broken links instead of hiding them", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const grokRoot = join(root, "grok-skills");
    const claudeRoot = join(root, "claude-skills");
    const codexRoot = join(root, "codex-skills");
    const missingSkill = join(root, "missing-skill");
    const missingCodexRoot = join(root, "missing-codex-root");
    mkdirSync(canonicalRoot);
    writeSkill(canonicalRoot, "healthy", "healthy\n");
    symlinkSync(missingSkill, join(canonicalRoot, "broken-skill"), "dir");
    symlinkSync(canonicalRoot, grokRoot, "dir");
    symlinkSync(canonicalRoot, claudeRoot, "dir");
    symlinkSync(missingCodexRoot, codexRoot, "dir");

    const result = auditSharedSkills({
      canonicalRoot,
      agentRoots: { grok: grokRoot, claude: claudeRoot, codex: codexRoot },
    });

    expect(result.consistent).toBe(false);
    expect(result.brokenLinks).toEqual([
      {
        scope: "canonical",
        path: join(canonicalRoot, "broken-skill"),
        target: missingSkill,
      },
      {
        scope: "agent",
        agent: "codex",
        path: codexRoot,
        target: missingCodexRoot,
      },
    ]);
  });
});

describe("review harness shared-skill setup", () => {
  it("links a Codex-only fresh home idempotently without requiring optional harnesses", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const agentRoots = {
      grok: join(root, ".grok", "skills"),
      claude: join(root, ".claude", "skills"),
      codex: join(root, ".codex", "skills"),
    };
    mkdirSync(canonicalRoot);
    writeSkill(canonicalRoot, "agent-collaboration", "# Collaboration\n");

    expect(linkReviewHarnessSkills({ canonicalRoot, agentRoots, agents: ["codex"] }))
      .toEqual([{ agent: "codex", path: agentRoots.codex, status: "created" }]);
    expect(linkReviewHarnessSkills({ canonicalRoot, agentRoots, agents: ["codex"] }))
      .toEqual([{ agent: "codex", path: agentRoots.codex, status: "already_current" }]);

    const audit = auditSharedSkills({ canonicalRoot, agentRoots });
    expect(audit.agents.codex.resolvedRoot).toBe(realpathSync(canonicalRoot));
    expect(audit.agents.grok.resolvedRoot).toBeNull();
    expect(audit.agents.claude.resolvedRoot).toBeNull();
  });

  it("never replaces a conflicting destination or accepts a missing required skill", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const conflict = join(root, ".codex", "skills");
    const agentRoots = {
      grok: join(root, ".grok", "skills"),
      claude: join(root, ".claude", "skills"),
      codex: conflict,
    };
    mkdirSync(canonicalRoot);
    expect(() => linkReviewHarnessSkills({ canonicalRoot, agentRoots, agents: ["codex"] }))
      .toThrow(/missing required skill/i);
    writeSkill(canonicalRoot, "agent-collaboration", "# Collaboration\n");
    mkdirSync(conflict, { recursive: true });
    expect(() => linkReviewHarnessSkills({ canonicalRoot, agentRoots, agents: ["codex"] }))
      .toThrow(/conflicts/i);
    expect(realpathSync(conflict)).toBe(conflict);
  });

  it("reports a usable Codex-only topology while optional harnesses remain degraded", () => {
    const root = makeRoot();
    const canonicalRoot = join(root, "canonical");
    const agentRoots = {
      grok: join(root, ".grok", "skills"),
      claude: join(root, ".claude", "skills"),
      codex: join(root, ".codex", "skills"),
    };
    const codexBinary = join(root, "codex");
    mkdirSync(canonicalRoot);
    writeSkill(canonicalRoot, "agent-collaboration", "# Collaboration\n");
    writeFileSync(codexBinary, "#!/bin/sh\n", { mode: 0o700 });
    linkReviewHarnessSkills({ canonicalRoot, agentRoots, agents: ["codex"] });

    expect(inspectReviewReadiness({
      canonicalSkillRoot: canonicalRoot,
      agentSkillRoots: agentRoots,
      binaries: { grok: join(root, "missing-grok"), claude: join(root, "missing-claude"), codex: codexBinary },
    })).toMatchObject({
      readyForCodexOnly: true,
      degradedOptionalProviders: ["grok", "claude"],
      providers: {
        codex: { required: true, ready: true },
        grok: { required: false, ready: false },
        claude: { required: false, ready: false },
      },
    });
  });
});
