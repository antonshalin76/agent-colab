import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { EvalCaseSchema, EvalSuiteSchema } from "../src/eval/schema.js";
import { createPairParityReceipt, matchPairProfile } from "../src/eval/parity.js";
import { captureSkillManifest, freezeSkillBundle } from "../src/eval/skills.js";
import { computeFrozenSkillBundleHash } from "../src/eval/run-manifest.js";
import { EvalStore } from "../src/eval/store.js";
import {
  captureSourceReceipt,
  createSealedPair,
  verifySourceReceipt,
} from "../src/eval/snapshot.js";

const roots: string[] = [];
const sha = (character: string): string => character.repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix = "agent-collab-eval-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Eval Fixture",
      GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "Eval Fixture",
      GIT_COMMITTER_EMAIL: "eval@example.invalid",
    },
  }).trim();
}

function makeRepo(): { repo: string; revision: string } {
  const repo = makeRoot("agent-collab-eval-source-");
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".env\nbuild/\n");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "main.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "fixture");
  return { repo, revision: git(repo, "rev-parse", "HEAD") };
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const name = relative(root, path);
      const stat = lstatSync(path);
      hash.update(name);
      hash.update("\0");
      hash.update(String(stat.mode & 0o777));
      hash.update("\0");
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) hash.update(readlinkSync(path));
      else hash.update(readFileSync(path));
      hash.update("\0");
    }
  };
  visit(root);
  return hash.digest("hex");
}

function validCase() {
  return {
    id: "PUNTO-BUG-03",
    repository: "punto",
    category: "bug",
    runnable: true,
    source: { revision: sha("a"), treeHash: sha("b") },
    task: {
      stageFamily: "tdd_coding",
      promptHash: sha("c"),
      taskImageHash: sha("d"),
      oracleHash: sha("e"),
    },
    rubric: {
      checks: [
        { id: "strict-command", weight: 70, hardGate: true, command: ["npm", "test"] },
        { id: "scope", weight: 30, hardGate: false, evaluator: "changed-files" },
      ],
    },
  };
}

describe("paired benchmark manifest schemas", () => {
  it("accepts a frozen case and rejects rubrics that are not deterministic 100-point contracts", () => {
    expect(EvalCaseSchema.safeParse(validCase()).success).toBe(true);

    const wrongTotal = structuredClone(validCase());
    wrongTotal.rubric.checks[1]!.weight = 29;
    expect(EvalCaseSchema.safeParse(wrongTotal).success).toBe(false);

    const ambiguousOracle = structuredClone(validCase());
    ambiguousOracle.rubric.checks[0]!.evaluator = "also-run-this";
    expect(EvalCaseSchema.safeParse(ambiguousOracle).success).toBe(false);

    const zeroWeight = structuredClone(validCase());
    zeroWeight.rubric.checks = [
      { id: "zero", weight: 0, hardGate: false, evaluator: "zero" },
      { id: "all", weight: 100, hardGate: true, evaluator: "all" },
    ];
    expect(EvalCaseSchema.safeParse(zeroWeight).success).toBe(false);
  });

  it("validates suite identity, unique cases, declared efforts, seed, and repetitions", () => {
    const suite = {
      id: "local-v1",
      mode: "full",
      seed: 20260824,
      baselinePolicy: { tdd_coding: "codex" },
      efforts: ["medium", "high", "xhigh"],
      repetitions: 4,
      cases: [validCase()],
    };
    expect(EvalSuiteSchema.safeParse(suite).success).toBe(true);
    expect(EvalSuiteSchema.safeParse({ ...suite, repetitions: 6 }).success).toBe(true);
    expect(EvalSuiteSchema.safeParse({ ...suite, efforts: ["ultra"] }).success).toBe(false);
    expect(EvalSuiteSchema.safeParse({ ...suite, repetitions: 2 }).success).toBe(false);
    expect(EvalSuiteSchema.safeParse({ ...suite, repetitions: 3 }).success).toBe(false);
    expect(EvalSuiteSchema.safeParse({ ...suite, repetitions: 5 }).success).toBe(false);
    expect(EvalSuiteSchema.safeParse({ ...suite, cases: [validCase(), validCase()] }).success).toBe(false);
  });
});

describe("matched pair preflight", () => {
  const common = {
    effort: "high",
    promptHash: sha("0"),
    seedPatchHash: sha("a"),
    sourceTreeHash: sha("b"),
    taskImageHash: sha("1"),
    skillManifestHash: sha("2"),
    functionalToolProfileHash: sha("3"),
    nativeToolSemanticsHash: sha("c"),
    wallTimeoutMs: 600_000,
    outputLimitBytes: 1_000_000,
    diffLimitBytes: 500_000,
    maxFiles: 20,
    maxProcesses: 8,
    maxAttempts: 1,
    systemInstructionHash: sha("d"),
    projectInstructionHash: sha("e"),
    environmentHash: sha("4"),
    oracleHash: sha("5"),
  } as const;

  it("matches the pinned Grok and Codex models without requiring equal model IDs", () => {
    const profile = {
      grok: { ...common, provider: "grok", model: "grok-4.6", nativeToolManifestHash: sha("6") },
      codex: { ...common, provider: "codex", model: "gpt-5.6-sol", nativeToolManifestHash: sha("7") },
    };
    const result = matchPairProfile(profile);

    expect(result).toEqual({
      matched: true,
      launchAllowed: true,
      classification: null,
      mismatches: [],
    });
    const receipt = createPairParityReceipt(profile);
    expect(receipt).toMatchObject({
      version: "paired-parity-v1",
      matched: true,
      launchAllowed: true,
      mismatches: [],
    });
    expect(receipt.profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createPairParityReceipt({ codex: profile.codex, grok: profile.grok }))
      .toEqual(receipt);
  });

  it.each([
    { name: "effort", arm: "codex", field: "effort", replacement: "xhigh", mismatch: "effort" },
    { name: "prompt", arm: "codex", field: "promptHash", replacement: sha("9"), mismatch: "promptHash" },
    { name: "seed patch", arm: "codex", field: "seedPatchHash", replacement: sha("9"), mismatch: "seedPatchHash" },
    { name: "source tree", arm: "codex", field: "sourceTreeHash", replacement: sha("9"), mismatch: "sourceTreeHash" },
    { name: "task image", arm: "codex", field: "taskImageHash", replacement: sha("9"), mismatch: "taskImageHash" },
    { name: "skill manifest", arm: "codex", field: "skillManifestHash", replacement: sha("9"), mismatch: "skillManifestHash" },
    { name: "functional tools", arm: "codex", field: "functionalToolProfileHash", replacement: sha("9"), mismatch: "functionalToolProfileHash" },
    { name: "native tool semantics", arm: "codex", field: "nativeToolSemanticsHash", replacement: sha("9"), mismatch: "nativeToolSemanticsHash" },
    { name: "wall timeout", arm: "codex", field: "wallTimeoutMs", replacement: 599_999, mismatch: "wallTimeoutMs" },
    { name: "output limit", arm: "codex", field: "outputLimitBytes", replacement: 999_999, mismatch: "outputLimitBytes" },
    { name: "diff limit", arm: "codex", field: "diffLimitBytes", replacement: 499_999, mismatch: "diffLimitBytes" },
    { name: "file limit", arm: "codex", field: "maxFiles", replacement: 19, mismatch: "maxFiles" },
    { name: "process limit", arm: "codex", field: "maxProcesses", replacement: 7, mismatch: "maxProcesses" },
    { name: "attempt limit", arm: "codex", field: "maxAttempts", replacement: 2, mismatch: "maxAttempts" },
    { name: "system instructions", arm: "codex", field: "systemInstructionHash", replacement: sha("9"), mismatch: "systemInstructionHash" },
    { name: "project instructions", arm: "codex", field: "projectInstructionHash", replacement: sha("9"), mismatch: "projectInstructionHash" },
    { name: "environment", arm: "codex", field: "environmentHash", replacement: sha("9"), mismatch: "environmentHash" },
    { name: "oracle", arm: "codex", field: "oracleHash", replacement: sha("9"), mismatch: "oracleHash" },
    { name: "Grok provider", arm: "grok", field: "provider", replacement: "codex", mismatch: "grok.provider" },
    { name: "Codex provider", arm: "codex", field: "provider", replacement: "grok", mismatch: "codex.provider" },
    { name: "pinned Grok model", arm: "grok", field: "model", replacement: "grok-4.5", mismatch: "grok.model" },
    { name: "pinned Codex model", arm: "codex", field: "model", replacement: "gpt-5.6", mismatch: "codex.model" },
  ] as const)("blocks a cell on $name mismatch", ({ arm, field, replacement, mismatch }) => {
    const profiles = {
      grok: { ...common, provider: "grok", model: "grok-4.6", nativeToolManifestHash: sha("6") },
      codex: { ...common, provider: "codex", model: "gpt-5.6-sol", nativeToolManifestHash: sha("7") },
    };
    const result = matchPairProfile({
      ...profiles,
      [arm]: { ...profiles[arm], [field]: replacement },
    });

    expect(result).toMatchObject({
      matched: false,
      launchAllowed: false,
      classification: "harness_confounded",
      mismatches: [mismatch],
    });
  });

  it("hashes real shared skill references and blocks drift between arm captures", () => {
    const root = makeRoot("agent-collab-eval-skills-");
    const canonicalRoot = join(root, "canonical");
    const skillRoot = join(canonicalRoot, "paired-benchmark");
    const references = join(skillRoot, "references");
    const grokRoot = join(root, "grok-skills");
    const codexRoot = join(root, "codex-skills");
    mkdirSync(references, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "# Paired benchmark\n\nFollow [the rules](references/rules.md).\n",
    );
    writeFileSync(join(references, "rules.md"), "version one\n");
    symlinkSync(canonicalRoot, grokRoot, "dir");
    symlinkSync(canonicalRoot, codexRoot, "dir");

    const grokManifest = captureSkillManifest({ root: grokRoot, skills: ["paired-benchmark"] });
    const codexManifest = captureSkillManifest({ root: codexRoot, skills: ["paired-benchmark"] });
    expect(grokManifest.resolvedRoot).toBe(realpathSync(canonicalRoot));
    expect(codexManifest).toEqual(grokManifest);
    expect(grokManifest.files.map((file) => file.path)).toEqual([
      "paired-benchmark/SKILL.md",
      "paired-benchmark/references/rules.md",
    ]);

    writeFileSync(join(references, "rules.md"), "version two\n");
    const driftedCodexManifest = captureSkillManifest({ root: codexRoot, skills: ["paired-benchmark"] });
    expect(driftedCodexManifest.hash).not.toBe(grokManifest.hash);

    const result = matchPairProfile({
      grok: {
        ...common,
        provider: "grok",
        model: "grok-4.6",
        skillManifestHash: grokManifest.hash,
        nativeToolManifestHash: sha("6"),
      },
      codex: {
        ...common,
        provider: "codex",
        model: "gpt-5.6-sol",
        skillManifestHash: driftedCodexManifest.hash,
        nativeToolManifestHash: sha("7"),
      },
    });
    expect(result).toMatchObject({
      matched: false,
      launchAllowed: false,
      classification: "harness_confounded",
      mismatches: ["skillManifestHash"],
    });
  });

  it("freezes only the selected skill files into a reproducible bundle", () => {
    const root = makeRoot("agent-collab-eval-frozen-skills-");
    const source = join(root, "source");
    const selected = join(source, "selected");
    const destination = join(root, "frozen");
    mkdirSync(join(selected, "references"), { recursive: true });
    mkdirSync(join(source, "unselected"), { recursive: true });
    writeFileSync(join(selected, "SKILL.md"), "Use [rules](references/rules.md).\n");
    writeFileSync(join(selected, "references", "rules.md"), "fixed\n");
    writeFileSync(join(source, "unselected", "SKILL.md"), "not mounted\n");

    const frozen = freezeSkillBundle({
      sourceRoot: source,
      destinationRoot: destination,
      skills: ["selected"],
    });

    expect(frozen.hash).toBe(captureSkillManifest({ root: source, skills: ["selected"] }).hash);
    expect(computeFrozenSkillBundleHash(frozen.files)).toBe(frozen.hash);
    expect(frozen.files.map((file) => file.path)).toEqual([
      "selected/SKILL.md",
      "selected/references/rules.md",
    ]);
    expect(existsSync(join(destination, "unselected"))).toBe(false);
  });
});

describe("isolated eval state", () => {
  it("persists legal block transitions and rejects an idempotency-key payload conflict", () => {
    const root = makeRoot();
    const path = join(root, "eval.db");
    const store = new EvalStore(path);
    const original = store.createBlock({
      idempotencyKey: "local-v1:PUNTO-BUG-03:high:0",
      manifestHash: sha("a"),
      seed: 20260824,
      snapshotHash: sha("b"),
      parityReceiptHash: sha("c"),
    });
    expect(store.createBlock({
      idempotencyKey: "local-v1:PUNTO-BUG-03:high:0",
      manifestHash: sha("a"),
      seed: 20260824,
      snapshotHash: sha("b"),
      parityReceiptHash: sha("c"),
    })).toEqual(original);
    for (const conflict of [
      { manifestHash: sha("f") },
      { seed: 1 },
      { snapshotHash: sha("f") },
      { parityReceiptHash: sha("f") },
    ]) {
      expect(() => store.createBlock({
        idempotencyKey: "local-v1:PUNTO-BUG-03:high:0",
        manifestHash: sha("a"),
        seed: 20260824,
        snapshotHash: sha("b"),
        parityReceiptHash: sha("c"),
        ...conflict,
      })).toThrow(/idempotency|immutable/i);
    }

    expect(store.listBlocks()).toHaveLength(1);
    expect(store.advanceBlock(original.id, "preflighted", { receiptHash: sha("d") }).state)
      .toBe("preflighted");
    expect(store.advanceBlock(original.id, "running", { receiptHash: sha("e") }).state)
      .toBe("running");
    expect(() => store.advanceBlock(original.id, "planned", { receiptHash: sha("f") }))
      .toThrow(/transition/i);
    store.close();
  });

  it("deduplicates attempts and never relaunches or rewrites terminal evidence after resume", () => {
    const root = makeRoot();
    const path = join(root, "eval.db");
    let store = new EvalStore(path);
    const block = store.createBlock({
      idempotencyKey: "block",
      manifestHash: sha("a"),
      seed: 7,
      snapshotHash: sha("b"),
      parityReceiptHash: sha("c"),
    });
    const attempt = store.createAttempt({
      blockId: block.id,
      provider: "grok",
      repetition: 0,
      sessionId: "fresh-grok-session",
    });
    expect(store.createAttempt({
      blockId: block.id,
      provider: "grok",
      repetition: 0,
      sessionId: "fresh-grok-session",
    })).toEqual(attempt);
    expect(() => store.createAttempt({
      blockId: block.id,
      provider: "grok",
      repetition: 0,
      sessionId: "must-not-replace",
    })).toThrow(/idempotency|immutable|session/i);

    store.markAttemptLaunched(attempt.id, { launchReceiptHash: sha("d") });
    store.finishAttempt(attempt.id, { status: "completed", evidenceHash: sha("e") });
    store.close();

    store = new EvalStore(path);
    expect(store.isAttemptLaunchable(attempt.id)).toBe(false);
    expect(store.getAttempt(attempt.id)).toMatchObject({
      status: "completed",
      evidenceHash: sha("e"),
      sessionId: "fresh-grok-session",
    });
    expect(() => store.finishAttempt(attempt.id, { status: "failed", evidenceHash: sha("f") }))
      .toThrow(/terminal|immutable/i);
    store.close();
  });

  it("lists block attempts and invalidates only an unlaunched attempt with immutable evidence", () => {
    const root = makeRoot();
    const store = new EvalStore(join(root, "eval.db"));
    const block = store.createBlock({
      idempotencyKey: "invalidate-block",
      manifestHash: sha("a"),
      seed: 9,
      snapshotHash: sha("b"),
      parityReceiptHash: sha("c"),
    });
    const grok = store.createAttempt({
      blockId: block.id,
      provider: "grok",
      repetition: 0,
      sessionId: "grok-session",
    });
    const codex = store.createAttempt({
      blockId: block.id,
      provider: "codex",
      repetition: 0,
      sessionId: "codex-session",
    });

    expect(store.invalidateAttempt(codex.id, { evidenceHash: sha("d") })).toMatchObject({
      status: "invalidated",
      evidenceHash: sha("d"),
      launchReceiptHash: undefined,
    });
    expect(store.isAttemptLaunchable(codex.id)).toBe(false);
    expect(store.listAttempts(block.id).map((attempt) => attempt.id).sort())
      .toEqual([codex.id, grok.id].sort());
    expect(() => store.markAttemptLaunched(codex.id, { launchReceiptHash: sha("e") }))
      .toThrow(/launchable/i);
    expect(() => store.invalidateAttempt(codex.id, { evidenceHash: sha("f") }))
      .toThrow(/terminal|immutable/i);
    expect(store.advanceBlock(block.id, "inconclusive", { receiptHash: sha("f") }).state)
      .toBe("inconclusive");
    expect(() => store.advanceBlock(block.id, "running", { receiptHash: sha("9") }))
      .toThrow(/transition/i);
    store.close();
  });
});

describe("sealed Git snapshots", () => {
  it("creates byte-identical arms without hardlinks and preserves a dirty source", () => {
    const { repo, revision } = makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "dirty user change\n");
    writeFileSync(join(repo, ".env"), "SECRET=must-not-leak\n");
    mkdirSync(join(repo, "build"));
    writeFileSync(join(repo, "build", "artifact.bin"), "ignored\n");
    const before = captureSourceReceipt(repo);
    const destinationRoot = makeRoot("agent-collab-eval-arms-");

    const pair = createSealedPair({ sourceRepo: repo, revision, destinationRoot });

    expect(pair.disposition).toBe("ready");
    if (pair.disposition !== "ready") throw new Error("expected a supported fixture");
    expect(pair.grok.imageHash).toBe(pair.codex.imageHash);
    expect(pair.imageHash).toBe(pair.grok.imageHash);
    expect(treeDigest(pair.grok.path)).toBe(treeDigest(pair.codex.path));
    expect(readFileSync(join(pair.grok.path, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(pair.grok.path, ".env"))).toBe(false);
    expect(existsSync(join(pair.codex.path, ".env"))).toBe(false);
    expect(existsSync(join(pair.grok.path, ".git"))).toBe(false);
    writeFileSync(join(pair.grok.path, "tracked.txt"), "grok-only mutation\n");
    expect(readFileSync(join(pair.codex.path, "tracked.txt"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("dirty user change\n");
    expect(before.dirty).toBe(true);
    expect(before.status).toContain("tracked.txt");
    expect(captureSourceReceipt(repo)).toEqual(before);
    expect(verifySourceReceipt(repo, before)).toEqual({ unchanged: true, mismatches: [] });
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("dirty user change\n");
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("SECRET=must-not-leak\n");
  });

  it("detects source mutation after an integrity receipt", () => {
    const { repo } = makeRepo();
    const before = captureSourceReceipt(repo);
    writeFileSync(join(repo, "tracked.txt"), "changed after receipt\n");

    const result = verifySourceReceipt(repo, before);

    expect(result.unchanged).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining(["status", "trackedDiffHash"]));
  });

  it("ignores caller Git config and global attributes while materializing the pinned tree", () => {
    const { repo, revision } = makeRepo();
    const configRoot = makeRoot("agent-collab-eval-git-config-");
    const attributes = join(configRoot, "attributes");
    const config = join(configRoot, "gitconfig");
    writeFileSync(attributes, "tracked.txt export-ignore\n");
    writeFileSync(config, `[core]\n\tattributesFile = ${attributes}\n`);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const pair = createSealedPair({
        sourceRepo: repo,
        revision,
        destinationRoot: makeRoot("agent-collab-eval-config-arms-"),
      });
      expect(pair.disposition).toBe("ready");
      if (pair.disposition !== "ready") throw new Error("expected caller config isolation");
      expect(readFileSync(join(pair.grok.path, "tracked.txt"), "utf8")).toBe("committed\n");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it.each([".env.local", "id_rsa", "server.pem", "credentials.json"])(
    "marks tracked credential-like path %s inconclusive",
    (name) => {
      const { repo } = makeRepo();
      writeFileSync(join(repo, name), "credential-like fixture\n");
      git(repo, "add", name);
      git(repo, "commit", "-q", "-m", `add ${name}`);
      const pair = createSealedPair({
        sourceRepo: repo,
        revision: git(repo, "rev-parse", "HEAD"),
        destinationRoot: makeRoot("agent-collab-eval-credential-arms-"),
      });
      expect(pair).toMatchObject({
        disposition: "inconclusive",
        launchAllowed: false,
        reason: "credential_path",
      });
    },
  );

  it("keeps a tracked environment example while rejecting live environment files", () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, ".env.example"), "SAFE_PLACEHOLDER=replace-me\n");
    git(repo, "add", "-f", ".env.example");
    git(repo, "commit", "-q", "-m", "environment template");
    const pair = createSealedPair({
      sourceRepo: repo,
      revision: git(repo, "rev-parse", "HEAD"),
      destinationRoot: makeRoot("agent-collab-eval-env-template-arms-"),
    });
    expect(pair.disposition).toBe("ready");
    if (pair.disposition !== "ready") throw new Error("expected safe environment template");
    expect(readFileSync(join(pair.grok.path, ".env.example"), "utf8"))
      .toBe("SAFE_PLACEHOLDER=replace-me\n");
  });

  it("fails closed when committed archive attributes omit a tracked file", () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, ".gitattributes"), "tracked.txt export-ignore\n");
    git(repo, "add", ".gitattributes");
    git(repo, "commit", "-q", "-m", "archive attributes");
    expect(createSealedPair({
      sourceRepo: repo,
      revision: git(repo, "rev-parse", "HEAD"),
      destinationRoot: makeRoot("agent-collab-eval-attributes-arms-"),
    })).toMatchObject({
      disposition: "inconclusive",
      launchAllowed: false,
      reason: "archive_tree_mismatch",
    });
  });

  it("fails closed when committed archive attributes rewrite tracked bytes", () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "$Format:%H$\n");
    writeFileSync(join(repo, ".gitattributes"), "tracked.txt export-subst\n");
    git(repo, "add", ".gitattributes", "tracked.txt");
    git(repo, "commit", "-q", "-m", "substitution attributes");
    expect(createSealedPair({
      sourceRepo: repo,
      revision: git(repo, "rev-parse", "HEAD"),
      destinationRoot: makeRoot("agent-collab-eval-subst-arms-"),
    })).toMatchObject({
      disposition: "inconclusive",
      launchAllowed: false,
      reason: "archive_tree_mismatch",
    });
  });

  it("rejects control characters in archive member paths before extraction", () => {
    const { repo } = makeRepo();
    const unsafeName = "unsafe\nname.txt";
    writeFileSync(join(repo, unsafeName), "unsafe path fixture\n");
    git(repo, "add", unsafeName);
    git(repo, "commit", "-q", "-m", "unsafe path");
    expect(createSealedPair({
      sourceRepo: repo,
      revision: git(repo, "rev-parse", "HEAD"),
      destinationRoot: makeRoot("agent-collab-eval-unsafe-arms-"),
    })).toMatchObject({
      disposition: "inconclusive",
      launchAllowed: false,
      reason: "unsafe_path",
    });
  });

  it.each([
    {
      name: "tracked symlink",
      prepare(repo: string) {
        symlinkSync("tracked.txt", join(repo, "linked.txt"));
        git(repo, "add", "linked.txt");
      },
      reason: "symlink",
    },
    {
      name: "submodule gitlink",
      prepare(repo: string) {
        const target = git(repo, "rev-parse", "HEAD");
        git(repo, "update-index", "--add", "--cacheinfo", `160000,${target},vendor/sub`);
      },
      reason: "submodule",
    },
    {
      name: "Git LFS pointer",
      prepare(repo: string) {
        writeFileSync(
          join(repo, "large.bin"),
          `version https://git-lfs.github.com/spec/v1\noid sha256:${sha("9")}\nsize 1\n`,
        );
        git(repo, "add", "large.bin");
      },
      reason: "lfs_pointer",
    },
  ])("marks $name snapshots inconclusive instead of launching partial images", ({ prepare, reason }) => {
    const { repo } = makeRepo();
    prepare(repo);
    git(repo, "commit", "-q", "-m", `add ${reason}`);
    const revision = git(repo, "rev-parse", "HEAD");
    const destinationRoot = makeRoot("agent-collab-eval-unsupported-");

    const pair = createSealedPair({ sourceRepo: repo, revision, destinationRoot });

    expect(pair).toMatchObject({
      disposition: "inconclusive",
      reason,
      launchAllowed: false,
    });
  });
});
