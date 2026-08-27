import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeOracleContract,
  deriveCorpusSuite,
  loadLockedCorpus,
  prepareCorpusCase,
} from "../src/eval/corpus.js";
import { hashSnapshotTree } from "../src/eval/snapshot.js";

const roots: string[] = [];
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const root = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Eval",
    GIT_AUTHOR_EMAIL: "eval@example.invalid",
    GIT_COMMITTER_NAME: "Eval",
    GIT_COMMITTER_EMAIL: "eval@example.invalid",
  },
}).trim();

function fixture(options: { badPatch?: boolean; runnable?: boolean } = {}) {
  const runnable = options.runnable ?? true;
  const repository = root("eval-corpus-repo-");
  git(repository, "init", "-q", "-b", "main");
  writeFileSync(join(repository, "value.txt"), "before\n");
  git(repository, "add", ".");
  git(repository, "commit", "-q", "-m", "fixture");
  const revision = git(repository, "rev-parse", "HEAD");
  const treeHash = git(repository, "rev-parse", "HEAD^{tree}");

  const corpusRoot = root("eval-corpus-manifest-");
  for (const directory of ["tasks", "rubrics", "seeds", "oracles"]) {
    mkdirSync(join(corpusRoot, directory));
  }
  const prompt = "Fix the seeded value.\n";
  const rubric = {
    checks: [{ id: "value", weight: 100, hardGate: true, evaluator: "value-is-after" }],
  };
  const seedPatch = options.badPatch ? "not a patch\n" : [
    "diff --git a/value.txt b/value.txt",
    "index 90be1f3..3bd1f0e 100644",
    "--- a/value.txt",
    "+++ b/value.txt",
    "@@ -1 +1 @@",
    "-before",
    "+seeded",
    "",
  ].join("\n");
  const promptPath = join(corpusRoot, "tasks", "CASE-01.md");
  const rubricPath = join(corpusRoot, "rubrics", "CASE-01.json");
  const seedPatchPath = join(corpusRoot, "seeds", "CASE-01.patch");
  const oraclePath = join(corpusRoot, "oracles", "CASE-01.mjs");
  writeFileSync(promptPath, prompt);
  writeFileSync(rubricPath, JSON.stringify(rubric));
  writeFileSync(seedPatchPath, seedPatch);
  writeFileSync(oraclePath, "export const expected = 'seeded';\n");
  const oracleFiles = runnable ? ["oracles/CASE-01.mjs"] : [];
  const oracle = computeOracleContract({
    corpusRoot,
    rubricPath,
    oraclePaths: runnable ? [oraclePath] : [],
  });
  const promptHash = sha256(prompt);
  const seedPatchHash = sha256(seedPatch);
  const taskImageHash = sha256(JSON.stringify({ revision, treeHash, promptHash, seedPatchHash }));

  const corpus = {
    id: "fixture-v1",
    seed: 7,
    baselinePolicy: { tdd_coding: "codex" },
    providers: { grok: { model: "grok-4.6" }, codex: { model: "gpt-5.6-sol" } },
    efforts: ["medium"],
    repetitions: 4,
    limits: {
      wallTimeoutMs: 1000,
      outputLimitBytes: 1000,
      diffLimitBytes: 1000,
      maxFiles: 2,
      maxProcesses: 2,
      maxAttempts: 1,
    },
    skills: ["karpathy-guidelines"],
    repositories: { fixture: { defaultPath: repository } },
    cases: [{
      id: "CASE-01",
      repository: "fixture",
      category: "bug",
      stageFamily: "tdd_coding",
      runnable,
      source: { revision, treeHash },
      task: "tasks/CASE-01.md",
      rubric: "rubrics/CASE-01.json",
      oracleFiles,
      seedPatch: "seeds/CASE-01.patch",
    }],
  };
  const suite = {
    id: "fixture-v1",
    mode: "full",
    seed: 7,
    baselinePolicy: { tdd_coding: "codex" },
    efforts: ["medium"],
    repetitions: 4,
    cases: [{
      id: "CASE-01",
      repository: "fixture",
      category: "bug",
      runnable,
      source: { revision, treeHash },
      task: {
        stageFamily: "tdd_coding",
        promptHash,
        taskImageHash,
        oracleHash: oracle.hash,
      },
      rubric,
    }],
  };
  const corpusPath = join(corpusRoot, "corpus.json");
  const suitePath = join(corpusRoot, "suite.json");
  writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  writeFileSync(suitePath, `${JSON.stringify(suite, null, 2)}\n`);
  return {
    repository,
    revision,
    treeHash,
    corpusPath,
    suitePath,
    seedPatchPath,
    oraclePath,
  };
}

describe("locked paired corpus", () => {
  it("round-trips the committed suite and locks source, rubric, and executable oracle evidence", () => {
    const input = fixture();
    const before = git(input.repository, "status", "--porcelain=v1");

    const locked = loadLockedCorpus(input.corpusPath);

    expect(locked.suite).toMatchObject({
      id: "fixture-v1",
      seed: 7,
      efforts: ["medium"],
      repetitions: 4,
      cases: [{
        id: "CASE-01",
        runnable: true,
        source: { revision: input.revision, treeHash: input.treeHash },
      }],
    });
    expect(locked.hashes.corpus).toMatch(/^[a-f0-9]{64}$/);
    expect(locked.hashes.suite).toBe(sha256(readFileSync(input.suitePath)));
    expect(locked.cases[0]).toMatchObject({
      prompt: "Fix the seeded value.\n",
      runnable: true,
      oraclePaths: [input.oraclePath],
    });
    expect(locked.cases[0]?.oracleFiles).toHaveLength(1);
    expect(locked.cases[0]?.oracleHash).toBe(locked.suite.cases[0]?.task.oracleHash);
    expect(git(input.repository, "status", "--porcelain=v1")).toBe(before);
  });

  it("prepares independent seeded copies from locked bytes and hashes their actual trees", () => {
    const input = fixture();
    const locked = loadLockedCorpus(input.corpusPath);
    writeFileSync(input.seedPatchPath, "tampered after lock\n");
    const destinationRoot = root("eval-corpus-copies-");
    const before = readFileSync(join(input.repository, "value.txt"), "utf8");

    const prepared = prepareCorpusCase({ locked, caseId: "CASE-01", destinationRoot });

    expect(prepared.disposition).toBe("ready");
    if (prepared.disposition !== "ready") throw new Error("expected ready pair");
    expect(readFileSync(join(prepared.grok.path, "value.txt"), "utf8")).toBe("seeded\n");
    expect(readFileSync(join(prepared.codex.path, "value.txt"), "utf8")).toBe("seeded\n");
    expect(prepared.seededImageHash).toBe(hashSnapshotTree(prepared.grok.path));
    expect(prepared.grok.imageHash).toBe(prepared.seededImageHash);
    expect(prepared.codex.imageHash).toBe(prepared.seededImageHash);
    writeFileSync(join(prepared.grok.path, "value.txt"), "grok only\n");
    expect(readFileSync(join(prepared.codex.path, "value.txt"), "utf8")).toBe("seeded\n");
    expect(readFileSync(join(input.repository, "value.txt"), "utf8")).toBe(before);
  });

  it("cleans both arms when applying the frozen seed fails", () => {
    const input = fixture({ badPatch: true });
    const locked = loadLockedCorpus(input.corpusPath);
    const destinationRoot = root("eval-corpus-failed-seed-");

    expect(() => prepareCorpusCase({ locked, caseId: "CASE-01", destinationRoot }))
      .toThrow(/patch|apply/i);
    expect(readdirSync(destinationRoot)).toEqual([]);
  });

  it("marks a case without executable oracle evidence non-runnable", () => {
    const input = fixture({ runnable: false });
    const locked = loadLockedCorpus(input.corpusPath);
    expect(locked.suite.cases[0]?.runnable).toBe(false);
    expect(prepareCorpusCase({
      locked,
      caseId: "CASE-01",
      destinationRoot: root("eval-corpus-not-runnable-"),
    })).toMatchObject({
      disposition: "inconclusive",
      launchAllowed: false,
      reason: "case_not_runnable",
    });
  });

  it("rejects runnable cases without oracle files and paths escaping the corpus root", () => {
    const input = fixture();
    const raw = JSON.parse(readFileSync(input.corpusPath, "utf8")) as Record<string, unknown>;
    const item = (raw.cases as Array<Record<string, unknown>>)[0]!;
    item.oracleFiles = [];
    writeFileSync(input.corpusPath, JSON.stringify(raw));
    expect(() => loadLockedCorpus(input.corpusPath)).toThrow(/oracle/i);

    item.oracleFiles = ["../secret.mjs"];
    writeFileSync(input.corpusPath, JSON.stringify(raw));
    expect(() => loadLockedCorpus(input.corpusPath)).toThrow(/artifact.*corpus|escape/i);
  });

  it("rejects a historical revision whose declared tree lock is wrong", () => {
    const input = fixture();
    writeFileSync(join(input.repository, "value.txt"), "later\n");
    git(input.repository, "add", ".");
    git(input.repository, "commit", "-q", "-m", "later");
    const laterTree = git(input.repository, "rev-parse", "HEAD^{tree}");
    const raw = JSON.parse(readFileSync(input.corpusPath, "utf8")) as Record<string, unknown>;
    const item = (raw.cases as Array<Record<string, unknown>>)[0]!;
    item.source = { revision: input.revision, treeHash: laterTree };
    writeFileSync(input.corpusPath, JSON.stringify(raw));

    expect(() => loadLockedCorpus(input.corpusPath)).toThrow(/tree hash mismatch/i);
  });

  it("supports explicit repository path overrides without weakening source locks", () => {
    const input = fixture();
    const raw = JSON.parse(readFileSync(input.corpusPath, "utf8")) as Record<string, unknown>;
    (raw.repositories as Record<string, Record<string, unknown>>).fixture!.defaultPath = "/missing/repo";
    writeFileSync(input.corpusPath, JSON.stringify(raw));

    expect(loadLockedCorpus(input.corpusPath, {
      repositoryPaths: { fixture: input.repository },
    }).suite.cases[0]?.source).toEqual({ revision: input.revision, treeHash: input.treeHash });
  });

  it("rejects a committed suite that does not round-trip from corpus inputs", () => {
    const input = fixture();
    const suite = JSON.parse(readFileSync(input.suitePath, "utf8")) as Record<string, unknown>;
    suite.seed = 8;
    writeFileSync(input.suitePath, JSON.stringify(suite));
    expect(() => loadLockedCorpus(input.corpusPath)).toThrow(/committed suite.*match|round-trip/i);
  });

  it("derives a new suite from verified inputs without trusting the stale committed suite", () => {
    const input = fixture();
    const suite = JSON.parse(readFileSync(input.suitePath, "utf8")) as Record<string, unknown>;
    suite.seed = 8;
    writeFileSync(input.suitePath, JSON.stringify(suite));

    const derived = deriveCorpusSuite(input.corpusPath);

    expect(derived.suite.seed).toBe(7);
    expect(derived.hashes.suite).toMatch(/^[a-f0-9]{64}$/);
    expect(() => loadLockedCorpus(input.corpusPath)).toThrow(/committed suite.*match/i);
  });

  it("rejects task paths that escape the corpus root", () => {
    const input = fixture();
    const raw = JSON.parse(readFileSync(input.corpusPath, "utf8")) as Record<string, unknown>;
    (raw.cases as Array<Record<string, unknown>>)[0]!.task = "../secret.md";
    writeFileSync(input.corpusPath, JSON.stringify(raw));
    expect(() => loadLockedCorpus(input.corpusPath)).toThrow(/artifact.*corpus|escape/i);
  });
});
