import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { EvalSuiteSchema, type EvalSuite } from "./schema.js";
import {
  createSealedPair,
  hashSnapshotTree,
  runIsolatedGit,
  type SealedPair,
} from "./snapshot.js";

const ORACLE_FORMAT_VERSION = "agent-collab-oracle-v1";
const ORACLE_NORMALIZATION_VERSION = "integer-weights-100-v1";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const fullGitObject = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const relativeArtifact = z.string().min(1);
const limitsSchema = z.object({
  wallTimeoutMs: z.number().int().positive(),
  outputLimitBytes: z.number().int().positive(),
  diffLimitBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  maxProcesses: z.number().int().positive(),
  maxAttempts: z.literal(1),
}).strict();

const corpusSchema = z.object({
  id: z.string().min(1),
  seed: z.number().int().nonnegative(),
  baselinePolicy: z.record(z.string().min(1), z.enum(["grok", "codex"])),
  providers: z.object({
    grok: z.object({ model: z.literal("grok-4.6") }).strict(),
    codex: z.object({ model: z.literal("gpt-5.6-sol") }).strict(),
  }).strict(),
  efforts: z.array(z.enum(["medium", "high", "xhigh"])).min(1),
  repetitions: z.number().int().min(4),
  limits: limitsSchema,
  skills: z.array(z.string().min(1)).min(1),
  repositories: z.record(z.string().min(1), z.object({
    defaultPath: z.string().min(1),
  }).strict()),
  cases: z.array(z.object({
    id: z.string().min(1),
    repository: z.string().min(1),
    category: z.enum(["refactor", "reliability", "bug", "optimization"]),
    stageFamily: z.enum([
      "coordination", "planning", "prd", "architecture", "ui_ux", "bdd",
      "tdd_coding", "unit_testing", "e2e_testing", "e2e_infrastructure",
      "plan_audit", "prd_audit", "architecture_audit", "test_audit",
      "code_audit", "code_review", "plan_critic", "prd_critic",
      "architecture_critic", "test_critic", "code_critic",
    ]),
    runnable: z.boolean(),
    source: z.object({ revision: fullGitObject, treeHash: fullGitObject }).strict(),
    task: relativeArtifact,
    rubric: relativeArtifact,
    oracleFiles: z.array(relativeArtifact),
    seedPatch: relativeArtifact.optional(),
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  if (value.repetitions % 2 !== 0) {
    context.addIssue({ code: "custom", path: ["repetitions"], message: "repetitions must be even" });
  }
  const caseIds = value.cases.map((item) => item.id);
  if (new Set(caseIds).size !== caseIds.length) {
    context.addIssue({ code: "custom", path: ["cases"], message: "case ids must be unique" });
  }
  for (const [index, item] of value.cases.entries()) {
    if (!Object.hasOwn(value.baselinePolicy, item.stageFamily)) {
      context.addIssue({
        code: "custom",
        path: ["baselinePolicy"],
        message: `baseline policy is missing ${item.stageFamily} for case ${index}`,
      });
    }
  }
  for (const [index, item] of value.cases.entries()) {
    if (!Object.hasOwn(value.repositories, item.repository)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "repository"],
        message: "case repository is not declared",
      });
    }
    if (item.runnable && item.oracleFiles.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "oracleFiles"],
        message: "runnable case requires executable oracle files",
      });
    }
    if (new Set(item.oracleFiles).size !== item.oracleFiles.length) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "oracleFiles"],
        message: "oracle files must be unique",
      });
    }
  }
});

type Corpus = z.infer<typeof corpusSchema>;

export interface OracleContractFile {
  readonly path: string;
  readonly sha256: string;
}

export interface OracleContract {
  readonly version: typeof ORACLE_FORMAT_VERSION;
  readonly normalization: typeof ORACLE_NORMALIZATION_VERSION;
  readonly files: readonly OracleContractFile[];
  readonly hash: string;
}

export interface LockedCorpusCase {
  readonly id: string;
  readonly repository: string;
  readonly repositoryPath: string;
  readonly revision: string;
  readonly treeHash: string;
  readonly runnable: boolean;
  readonly prompt: string;
  readonly promptPath: string;
  readonly rubricPath: string;
  readonly seedPatchPath: string | null;
  readonly seedPatch: string | null;
  readonly seedPatchHash: string;
  readonly oraclePaths: readonly string[];
  readonly oracleFiles: readonly OracleContractFile[];
  readonly oracleHash: string;
}

export interface LockedCorpus {
  readonly corpusPath: string;
  readonly suitePath: string;
  readonly root: string;
  readonly suite: EvalSuite;
  readonly limits: Corpus["limits"];
  readonly skills: readonly string[];
  readonly providers: Corpus["providers"];
  readonly cases: readonly LockedCorpusCase[];
  readonly hashes: { readonly corpus: string; readonly suite: string };
}

export interface DerivedCorpusSuite {
  readonly corpusPath: string;
  readonly root: string;
  readonly suite: EvalSuite;
  readonly limits: Corpus["limits"];
  readonly skills: readonly string[];
  readonly providers: Corpus["providers"];
  readonly cases: readonly LockedCorpusCase[];
  readonly hashes: { readonly corpus: string; readonly suite: string };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const artifactPath = (root: string, requested: string): string => {
  if (isAbsolute(requested)) throw new Error("artifact path must stay inside corpus root");
  const lexical = resolve(root, requested);
  if (!inside(root, lexical)) throw new Error("artifact path escapes corpus root");
  const canonical = realpathSync(lexical);
  if (!inside(root, canonical)) throw new Error("artifact symlink escapes corpus root");
  return canonical;
};

const gitText = (repository: string, ...args: string[]): string =>
  runIsolatedGit({ cwd: repository, args }).toString("utf8").trim();

export function computeOracleContract(input: {
  corpusRoot: string;
  rubricPath: string;
  oraclePaths: readonly string[];
}): OracleContract {
  const root = realpathSync(input.corpusRoot);
  const paths = [realpathSync(input.rubricPath), ...input.oraclePaths.map((path) => realpathSync(path))];
  for (const path of paths) {
    if (!inside(root, path)) throw new Error("oracle artifact escapes corpus root");
  }
  const files = paths.map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    sha256: sha256(readFileSync(path)),
  }));
  const [rubric, ...oracles] = files;
  const ordered = [rubric!, ...oracles.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  )];
  const body = {
    version: ORACLE_FORMAT_VERSION,
    normalization: ORACLE_NORMALIZATION_VERSION,
    files: ordered,
  } as const;
  return deepFreeze({ ...body, hash: sha256(JSON.stringify(body)) });
}

export function deriveCorpusSuite(
  corpusPath: string,
  options: { repositoryPaths?: Readonly<Record<string, string>> } = {},
): DerivedCorpusSuite {
  const absoluteCorpusPath = realpathSync(corpusPath);
  const root = realpathSync(dirname(absoluteCorpusPath));
  const corpusBytes = readFileSync(absoluteCorpusPath);
  const corpus = corpusSchema.parse(JSON.parse(corpusBytes.toString("utf8")));
  const unknownOverrides = Object.keys(options.repositoryPaths ?? {})
    .filter((name) => !Object.hasOwn(corpus.repositories, name));
  if (unknownOverrides.length > 0) {
    throw new Error(`repository path override is not declared: ${unknownOverrides.join(",")}`);
  }
  const lockedCases: LockedCorpusCase[] = [];
  const evalCases = corpus.cases.map((item) => {
    const repository = corpus.repositories[item.repository]!;
    const repositoryPath = realpathSync(options.repositoryPaths?.[item.repository] ?? repository.defaultPath);
    const revision = gitText(repositoryPath, "rev-parse", "--verify", `${item.source.revision}^{commit}`);
    if (revision !== item.source.revision) throw new Error(`case ${item.id} revision is not exact`);
    const treeHash = gitText(repositoryPath, "rev-parse", "--verify", `${revision}^{tree}`);
    if (treeHash !== item.source.treeHash) throw new Error(`case ${item.id} tree hash mismatch`);

    const promptPath = artifactPath(root, item.task);
    const rubricPath = artifactPath(root, item.rubric);
    const seedPatchPath = item.seedPatch ? artifactPath(root, item.seedPatch) : null;
    const oraclePaths = item.oracleFiles.map((path) => artifactPath(root, path));
    const promptBytes = readFileSync(promptPath);
    const rubricBytes = readFileSync(rubricPath);
    const seedPatchBytes = seedPatchPath ? readFileSync(seedPatchPath) : Buffer.alloc(0);
    const rubric = JSON.parse(rubricBytes.toString("utf8")) as unknown;
    const promptHash = sha256(promptBytes);
    const seedPatchHash = sha256(seedPatchBytes);
    const taskImageHash = sha256(JSON.stringify({ revision, treeHash, promptHash, seedPatchHash }));
    const oracle = computeOracleContract({ corpusRoot: root, rubricPath, oraclePaths });
    lockedCases.push(Object.freeze({
      id: item.id,
      repository: item.repository,
      repositoryPath,
      revision,
      treeHash,
      runnable: item.runnable,
      prompt: promptBytes.toString("utf8"),
      promptPath,
      rubricPath,
      seedPatchPath,
      seedPatch: seedPatchPath ? seedPatchBytes.toString("utf8") : null,
      seedPatchHash,
      oraclePaths: Object.freeze([...oraclePaths]),
      oracleFiles: Object.freeze(oracle.files.slice(1)),
      oracleHash: oracle.hash,
    }));
    return {
      id: item.id,
      repository: item.repository,
      category: item.category,
      runnable: item.runnable,
      source: { revision, treeHash },
      task: { stageFamily: item.stageFamily, promptHash, taskImageHash, oracleHash: oracle.hash },
      rubric,
    };
  });
  const derivedSuite = EvalSuiteSchema.parse({
    id: corpus.id,
    mode: "full",
    seed: corpus.seed,
    baselinePolicy: corpus.baselinePolicy,
    efforts: corpus.efforts,
    repetitions: corpus.repetitions,
    cases: evalCases,
  });
  return deepFreeze({
    corpusPath: absoluteCorpusPath,
    root,
    suite: derivedSuite,
    limits: corpus.limits,
    skills: [...corpus.skills],
    providers: corpus.providers,
    cases: lockedCases,
    hashes: { corpus: sha256(corpusBytes), suite: sha256(JSON.stringify(derivedSuite)) },
  });
}

export function loadLockedCorpus(
  corpusPath: string,
  options: { repositoryPaths?: Readonly<Record<string, string>> } = {},
): LockedCorpus {
  const derived = deriveCorpusSuite(corpusPath, options);
  const suitePath = artifactPath(derived.root, "suite.json");
  const suiteBytes = readFileSync(suitePath);
  const committedSuite = EvalSuiteSchema.parse(JSON.parse(suiteBytes.toString("utf8")));
  if (!isDeepStrictEqual(committedSuite, derived.suite)) {
    throw new Error("committed suite does not match corpus round-trip");
  }
  return deepFreeze({
    ...derived,
    suitePath,
    suite: committedSuite,
    hashes: { corpus: derived.hashes.corpus, suite: sha256(suiteBytes) },
  });
}

type PreparationFailure = Extract<SealedPair, { disposition: "inconclusive" }> | Readonly<{
  disposition: "inconclusive";
  launchAllowed: false;
  reason: "case_not_runnable" | "seeded_arms_mismatch";
}>;

export type PreparedCorpusCase = PreparationFailure | Readonly<{
  disposition: "ready";
  launchAllowed: true;
  imageHash: string;
  grok: { path: string; imageHash: string };
  codex: { path: string; imageHash: string };
  sourceReceiptBefore: Extract<SealedPair, { disposition: "ready" }>["sourceReceiptBefore"];
  sourceReceiptAfter: Extract<SealedPair, { disposition: "ready" }>["sourceReceiptAfter"];
  caseId: string;
  seededImageHash: string;
}>;

export function prepareCorpusCase(input: {
  locked: LockedCorpus;
  caseId: string;
  destinationRoot: string;
}): PreparedCorpusCase {
  const item = input.locked.cases.find((candidate) => candidate.id === input.caseId);
  if (!item) throw new Error(`unknown corpus case: ${input.caseId}`);
  if (!item.runnable) {
    return { disposition: "inconclusive", launchAllowed: false, reason: "case_not_runnable" };
  }
  const pair = createSealedPair({
    sourceRepo: item.repositoryPath,
    revision: item.revision,
    destinationRoot: input.destinationRoot,
  });
  if (pair.disposition !== "ready") return pair;
  try {
    if (item.seedPatch !== null) {
      for (const arm of [pair.grok, pair.codex]) {
        runIsolatedGit({
          cwd: arm.path,
          args: ["apply", "--no-index", "--whitespace=nowarn", "-"],
          stdin: item.seedPatch,
        });
      }
    }
    const grokHash = hashSnapshotTree(pair.grok.path);
    const codexHash = hashSnapshotTree(pair.codex.path);
    if (grokHash !== codexHash) {
      rmSync(pair.grok.path, { recursive: true, force: true });
      rmSync(pair.codex.path, { recursive: true, force: true });
      return {
        disposition: "inconclusive",
        launchAllowed: false,
        reason: "seeded_arms_mismatch",
      };
    }
    return {
      ...pair,
      imageHash: grokHash,
      grok: { ...pair.grok, imageHash: grokHash },
      codex: { ...pair.codex, imageHash: codexHash },
      caseId: item.id,
      seededImageHash: grokHash,
    };
  } catch (error) {
    rmSync(pair.grok.path, { recursive: true, force: true });
    rmSync(pair.codex.path, { recursive: true, force: true });
    throw new Error(`seed patch application failed for ${item.id}`, { cause: error });
  }
}
