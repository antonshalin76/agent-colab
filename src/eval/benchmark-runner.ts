import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Effort } from "../domain/routing.js";
import type { CommandSpec } from "../runners/provider-command.js";
import type { UsageTelemetry } from "../runners/codex.js";
import type { PreparedCorpusCase, LockedCorpusCase } from "./corpus.js";
import { evaluatePilotOracle, type OracleExecutionRequest } from "./oracle-registry.js";
import {
  buildContainedEvalProviderCommand,
  runEvalProviderAttempt,
  type EvalLaunchedProcess,
  type EvalProcessLauncher,
} from "./provider.js";
import type { PairedObservation, ProvenancedNumber } from "./scoring.js";
import type { EvalProvider, ExperimentCell } from "./schedule.js";
import {
  hashSnapshotTree,
  runIsolatedGit,
  verifySourceReceipt,
} from "./snapshot.js";

type ReadyPair = Extract<PreparedCorpusCase, { disposition: "ready" }>;
type ObservationArm = "A" | "B";
type ProviderRuntime = Readonly<{ binary: string; authFile: string }>;
type OracleExecutor = (request: OracleExecutionRequest) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export interface PairedBenchmarkLimits {
  readonly wallTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly diffLimitBytes: number;
  readonly maxFiles: number;
  readonly maxProcesses: number;
  readonly terminationGraceMs: number;
}

export interface PairedBenchmarkRuntime {
  readonly providers: Readonly<Record<EvalProvider, ProviderRuntime>>;
  readonly launcher: EvalProcessLauncher;
  readonly oracleExecute?: OracleExecutor;
  readonly oracleExecutor?: (input: Readonly<{
    caseId: string;
    workspaceRoot: string;
    oracleRoot: string;
    scratchRoot: string;
  }>) => OracleExecutor;
  readonly allowProviderNetwork?: boolean;
  readonly sessionId?: (provider: EvalProvider, arm: ObservationArm) => string;
  readonly now?: () => number;
}

export interface BenchmarkCaseDefinition {
  readonly id: string;
  readonly repositoryPath: string;
  readonly prompt: string;
  readonly oracleHash: string;
  readonly oraclePaths: LockedCorpusCase["oraclePaths"];
  readonly oracleFiles: LockedCorpusCase["oracleFiles"];
}

interface DiffEvidence {
  readonly bytes: number;
  readonly sha256: string;
  readonly changedFiles: readonly string[];
  readonly candidateMutation: boolean;
  readonly peakProcessCount: number;
  readonly processCountProvenance: "linux_process_group_poll" | "launcher_minimum";
  readonly forbiddenGitMetadata: boolean;
}

interface BlindArmEvidence {
  readonly arm: ObservationArm;
  readonly blindId: string;
  readonly status: "completed" | "failed" | "invalidated";
  readonly failure: Readonly<{ kind: string; reason: string }> | null;
  readonly diff: DiffEvidence;
  readonly oracle: Awaited<ReturnType<typeof evaluatePilotOracle>> | null;
  readonly observation: PairedObservation;
}

export interface PairedBenchmarkEvidence {
  readonly schemaVersion: "agent-collab-paired-cell-v2";
  readonly blockId: string;
  readonly caseId: string;
  readonly frozenInputs: Readonly<{
    taskHash: string;
    effort: string;
    limitsHash: string;
    seededImageHash: string;
    oracleHash: string;
    manifestHash: string;
  }>;
  readonly sourceUnchanged: true;
  readonly arms: readonly BlindArmEvidence[];
}

export interface PairedBenchmarkCellResult {
  readonly observations: readonly PairedObservation[];
  readonly evidence: PairedBenchmarkEvidence;
  readonly artifactPaths: Readonly<{
    root: string;
    observations: string;
    evidence: string;
    mapping: string;
  }>;
}

interface GitBaseline {
  readonly workspace: string;
  readonly gitDir: string;
  readonly tree: string;
}

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => JSON.stringify(value);

function inside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertSeparated(root: string, paths: readonly string[]): void {
  for (const path of paths) {
    if (inside(root, path) || inside(path, root)) {
      throw new Error("benchmark artifact root must be separate from source and candidate roots");
    }
  }
}

function git(baseline: Pick<GitBaseline, "workspace" | "gitDir">, args: string[]): Buffer {
  return runIsolatedGit({
    cwd: baseline.workspace,
    args: [`--git-dir=${baseline.gitDir}`, `--work-tree=${baseline.workspace}`, ...args],
  });
}

function stageTree(
  baseline: Pick<GitBaseline, "workspace" | "gitDir">,
  includeIgnored: boolean,
): string {
  git(baseline, ["add", "-A", ...(includeIgnored ? ["-f"] : []), "--", "."]);
  return git(baseline, ["write-tree"]).toString("utf8").trim();
}

function createGitBaseline(workspace: string, gitDir: string): GitBaseline {
  if (existsSync(join(workspace, ".git"))) {
    throw new Error("sealed candidate unexpectedly contains Git metadata");
  }
  mkdirSync(gitDir);
  const partial = { workspace, gitDir };
  git(partial, ["init", "--quiet"]);
  return { ...partial, tree: stageTree(partial, true) };
}

function observeDiff(baseline: GitBaseline, peak: ProcessGroupMonitor): DiffEvidence {
  if (existsSync(join(baseline.workspace, ".git"))) {
    return Object.freeze({
      bytes: 0,
      sha256: sha256("forbidden-in-workspace-git-metadata"),
      changedFiles: Object.freeze([".git/"]),
      candidateMutation: true,
      peakProcessCount: peak.peak,
      processCountProvenance: peak.provenance,
      forbiddenGitMetadata: true,
    });
  }
  const current = stageTree(baseline, false);
  const patch = git(baseline, [
    "diff", "--binary", "--no-ext-diff", baseline.tree, current, "--",
  ]);
  const changedFiles = git(baseline, [
    "diff", "--name-only", "-z", baseline.tree, current, "--",
  ]).toString("utf8").split("\0").filter(Boolean).sort();
  return Object.freeze({
    bytes: patch.length,
    sha256: sha256(patch),
    changedFiles: Object.freeze(changedFiles),
    candidateMutation: baseline.tree !== current,
    peakProcessCount: peak.peak,
    processCountProvenance: peak.provenance,
    forbiddenGitMetadata: false,
  });
}

function processGroupSize(pid: number): number {
  if (process.platform !== "linux" || !existsSync("/proc")) return 1;
  let count = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync("/proc", { withFileTypes: true, encoding: "utf8" });
  } catch {
    return 1;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const stat = readFileSync(join("/proc", entry.name, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (Number(fields[2]) === pid) count += 1;
    } catch {
      // A process can disappear between /proc enumeration and reading its stat file.
    }
  }
  return Math.max(1, count);
}

class ProcessGroupMonitor implements EvalProcessLauncher {
  peak = 1;
  provenance: DiffEvidence["processCountProvenance"] = "launcher_minimum";

  constructor(private readonly delegate: EvalProcessLauncher) {}

  launch(command: CommandSpec, limits?: { maxOutputBytes: number; env?: NodeJS.ProcessEnv }): EvalLaunchedProcess {
    const launched = this.delegate.launch(command, limits);
    if (launched.pid === undefined) return launched;
    this.provenance = process.platform === "linux"
      ? "linux_process_group_poll"
      : "launcher_minimum";
    const sample = (): void => { this.peak = Math.max(this.peak, processGroupSize(launched.pid!)); };
    sample();
    const timer = setInterval(sample, 20);
    void launched.result.then(
      () => clearInterval(timer),
      () => clearInterval(timer),
    );
    return launched;
  }
}

function copyPrivateOracles(input: {
  definition: BenchmarkCaseDefinition;
  root: string;
}): string {
  if (input.definition.oraclePaths.length !== input.definition.oracleFiles.length ||
      input.definition.oraclePaths.length === 0) {
    throw new Error("runnable benchmark requires a complete oracle contract");
  }
  mkdirSync(input.root, { recursive: true });
  const names = new Set<string>();
  input.definition.oraclePaths.forEach((source, index) => {
    const contract = input.definition.oracleFiles[index]!;
    const bytes = readFileSync(source);
    if (sha256(bytes) !== contract.sha256) throw new Error("oracle artifact hash mismatch");
    const name = basename(contract.path);
    if (names.has(name)) throw new Error("oracle artifact basename collision");
    names.add(name);
    copyFileSync(source, join(input.root, name));
  });
  return input.root;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failureFrom(outcome: Record<string, unknown>): { kind: string; reason: string } | null {
  const failure = asRecord(outcome.failure);
  return failure && typeof failure.kind === "string" && typeof failure.reason === "string"
    ? { kind: failure.kind, reason: failure.reason }
    : null;
}

const unavailable = (): ProvenancedNumber => ({ value: null, provenance: "unavailable" });

function usageFrom(outcome: Record<string, unknown>): PairedObservation["usage"] {
  const result = asRecord(outcome.result);
  const usage = asRecord(result?.usage);
  const provenance = asRecord(usage?.provenance);
  const field = (name: keyof UsageTelemetry): ProvenancedNumber => {
    const value = usage?.[name];
    const source = provenance?.[name];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
      typeof source === "string"
      ? { value, provenance: source }
      : unavailable();
  };
  return Object.freeze({
    inputTokens: field("inputTokens"),
    cachedInputTokens: field("cachedInputTokens"),
    outputTokens: field("outputTokens"),
    reasoningTokens: field("reasoningTokens"),
    totalTokens: field("totalTokens"),
    costUsd: field("costUsd"),
  });
}

function observation(input: {
  cell: ExperimentCell;
  arm: ObservationArm;
  wallTimeMs: number;
  outcome: Record<string, unknown>;
  oracle: Awaited<ReturnType<typeof evaluatePilotOracle>> | null;
}): PairedObservation {
  const completed = input.outcome.status === "completed";
  const failure = failureFrom(input.outcome);
  const invalidated = !completed && failure?.kind !== "execution_outcome";
  const defectFound = input.oracle?.hardGatesPassed === true ? 1 : 0;
  return Object.freeze({
    blockId: input.cell.blockId,
    caseId: input.cell.caseId,
    taskClass: input.cell.taskClass,
    stage: input.cell.stage,
    effort: input.cell.effort,
    policyId: input.cell.pairIdentity.policyId,
    repetition: input.cell.repetition,
    arm: input.arm,
    deterministicQuality: input.oracle?.hardGatesPassed === true ? input.oracle.points : 0,
    blindJudgeResolved: input.oracle !== null,
    executionStatus: completed ? "completed" : invalidated ? "invalidated" : "failed",
    defectMetrics: Object.freeze({
      seededDefectsFound: defectFound,
      seededDefectsTotal: 1,
      truePositiveFindings: 0,
      totalFindings: 0,
      escapedDefects: defectFound === 1 ? 0 : 1,
    }),
    reworkSteps: 0,
    wallTimeMs: input.wallTimeMs,
    usage: usageFrom(input.outcome),
  });
}

function validateCell(input: {
  cell: ExperimentCell;
  prepared: ReadyPair;
  definition: BenchmarkCaseDefinition;
  limits: PairedBenchmarkLimits;
}): asserts input is typeof input {
  if (input.cell.mode !== "stage_pair" || input.cell.armA.provider === "mixed" ||
      input.cell.armB.provider === "mixed" || input.cell.armA.provider === input.cell.armB.provider) {
    throw new Error("minimal paired runner requires one distinct provider per stage-pair arm");
  }
  const providers = [input.cell.armA.provider, input.cell.armB.provider].sort().join(",");
  if (providers !== "codex,grok" || [...input.cell.launchOrder].sort().join(",") !== providers) {
    throw new Error("cell provider mapping and launch order mismatch");
  }
  if (input.cell.caseId !== input.definition.id || input.prepared.caseId !== input.cell.caseId) {
    throw new Error("prepared case identity mismatch");
  }
  if (!new Set<string>(["medium", "high", "xhigh"]).has(input.cell.effort)) {
    throw new Error("unsupported paired benchmark effort");
  }
  for (const value of Object.values(input.limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid benchmark limit");
  }
  if (input.prepared.grok.imageHash !== input.prepared.codex.imageHash ||
      input.prepared.seededImageHash !== input.prepared.grok.imageHash ||
      hashSnapshotTree(input.prepared.grok.path) !== input.prepared.seededImageHash ||
      hashSnapshotTree(input.prepared.codex.path) !== input.prepared.seededImageHash) {
    throw new Error("prepared arms are not the same frozen image");
  }
}

export async function runPairedBenchmarkCell(input: {
  readonly cell: ExperimentCell;
  readonly prepared: ReadyPair;
  readonly caseDefinition: BenchmarkCaseDefinition;
  readonly runManifestHash: string;
  readonly artifactRoot: string;
  readonly skillRoot: string;
  readonly runtime: PairedBenchmarkRuntime;
  readonly limits: PairedBenchmarkLimits;
}): Promise<PairedBenchmarkCellResult> {
  validateCell({
    cell: input.cell,
    prepared: input.prepared,
    definition: input.caseDefinition,
    limits: input.limits,
  });
  if (!/^[a-f0-9]{64}$/.test(input.runManifestHash)) {
    throw new Error("paired benchmark requires a valid immutable run manifest hash");
  }
  if (!isAbsolute(input.artifactRoot) || !isAbsolute(input.skillRoot)) {
    throw new Error("benchmark artifact and skill roots must be absolute");
  }
  const artifactRoot = resolve(input.artifactRoot);
  mkdirSync(artifactRoot, { recursive: true });
  assertSeparated(artifactRoot, [
    input.prepared.grok.path,
    input.prepared.codex.path,
    input.caseDefinition.repositoryPath,
  ]);
  const sourceBefore = verifySourceReceipt(
    input.caseDefinition.repositoryPath,
    input.prepared.sourceReceiptBefore,
  );
  if (!sourceBefore.unchanged) throw new Error("source repository changed before paired execution");

  const pairRoot = join(realpathSync(artifactRoot), input.cell.blockId);
  mkdirSync(pairRoot);
  const privateRoot = join(pairRoot, "private");
  mkdirSync(privateRoot);
  const armRoots: Readonly<Record<ObservationArm, string>> = {
    A: realpathSync(input.prepared.grok.path),
    B: realpathSync(input.prepared.codex.path),
  };
  const armProviders: Readonly<Record<ObservationArm, EvalProvider>> = {
    A: input.cell.armA.provider as EvalProvider,
    B: input.cell.armB.provider as EvalProvider,
  };
  const providerArms = new Map<EvalProvider, ObservationArm>([
    [armProviders.A, "A"],
    [armProviders.B, "B"],
  ]);
  const baselines: Record<ObservationArm, GitBaseline> = {
    A: createGitBaseline(armRoots.A, join(privateRoot, "git-A")),
    B: createGitBaseline(armRoots.B, join(privateRoot, "git-B")),
  };
  const oracleRoots: Record<ObservationArm, string> = {
    A: copyPrivateOracles({
      definition: input.caseDefinition,
      root: join(privateRoot, "oracle-A"),
    }),
    B: copyPrivateOracles({
      definition: input.caseDefinition,
      root: join(privateRoot, "oracle-B"),
    }),
  };
  const now = input.runtime.now ?? Date.now;
  const evidenceByArm = new Map<ObservationArm, BlindArmEvidence>();

  for (const provider of input.cell.launchOrder) {
    const arm = providerArms.get(provider);
    if (!arm) throw new Error("launch order references an unmapped provider");
    const workspace = armRoots[arm];
    const runtime = input.runtime.providers[provider];
    const sessionId = input.runtime.sessionId?.(provider, arm) ?? randomUUID();
    const contained = buildContainedEvalProviderCommand({
      agent: provider,
      binary: runtime.binary,
      cwd: workspace,
      task: input.caseDefinition.prompt,
      effort: input.cell.effort as Effort,
      timeoutMs: input.limits.wallTimeoutMs,
      stateRoot: join(privateRoot, `state-${arm}`),
      authFile: runtime.authFile,
      skillRoot: input.skillRoot,
      ...(input.runtime.allowProviderNetwork ? { allowProviderNetwork: true } : {}),
      ...(provider === "grok" ? { sessionId } : {}),
    });
    const processMonitor = new ProcessGroupMonitor(input.runtime.launcher);
    const startedAt = now();
    const attempt = await runEvalProviderAttempt({
      agent: provider,
      command: contained.command,
      providerCommand: contained.innerCommand,
      containerExecutable: contained.containerExecutable,
      expectedModel: provider === "grok" ? "grok-4.6" : "gpt-5.6-sol",
      expectedEffort: input.cell.effort as Effort,
      ...(provider === "grok" ? { expectedSessionId: sessionId } : {}),
      launcher: processMonitor,
      terminationGraceMs: input.limits.terminationGraceMs,
      maxOutputBytes: input.limits.outputLimitBytes,
      budgetLimits: {
        maxDiffBytes: input.limits.diffLimitBytes,
        maxFiles: input.limits.maxFiles,
        maxProcesses: input.limits.maxProcesses,
      },
      observeBudgets: async () => {
        const diff = observeDiff(baselines[arm], processMonitor);
        return {
          diffBytes: diff.bytes,
          fileCount: diff.changedFiles.length,
          peakProcessCount: diff.peakProcessCount,
        };
      },
      observeAttemptActivity: async () => ({
        candidateMutation: observeDiff(baselines[arm], processMonitor).candidateMutation,
        toolActivity: false,
      }),
      env: contained.env,
    });
    const wallTimeMs = Math.max(0, now() - startedAt);
    const diff = observeDiff(baselines[arm], processMonitor);
    const finalAttempt = diff.forbiddenGitMetadata
      ? {
        status: "failed",
        failure: {
          kind: "execution_outcome",
          reason: "forbidden_in_workspace_git_metadata",
          countsTowardReliability: true,
        },
        cleanup: { processGroupTerminated: true },
        oracleAllowed: false,
      }
      : attempt;
    const oracleAllowed = finalAttempt.status === "completed" && finalAttempt.oracleAllowed === true;
    const oracleExecute = input.runtime.oracleExecutor?.({
      caseId: input.cell.caseId,
      workspaceRoot: workspace,
      oracleRoot: oracleRoots[arm],
      scratchRoot: join(privateRoot, `oracle-scratch-${arm}`),
    }) ?? input.runtime.oracleExecute;
    if (oracleAllowed && oracleExecute === undefined) {
      throw new Error("completed attempt requires an isolated oracle executor");
    }
    const oracle = oracleAllowed
      ? await evaluatePilotOracle({
          caseId: input.cell.caseId,
          workspaceRoot: workspace,
          oracleRoot: oracleRoots[arm],
          providerExited: true,
          changedFiles: diff.changedFiles,
          execute: oracleExecute!,
        })
      : null;
    const item = observation({ cell: input.cell, arm, wallTimeMs, outcome: finalAttempt, oracle });
    const failure = failureFrom(finalAttempt);
    evidenceByArm.set(arm, Object.freeze({
      arm,
      blindId: sha256(`${input.cell.blockId}\0${arm}`),
      status: item.executionStatus,
      failure,
      diff,
      oracle,
      observation: item,
    }));
    if (failure && ["provider_unavailable", "harness_failure", "harness_confounded"]
      .includes(failure.kind)) break;
  }

  for (const arm of ["A", "B"] as const) {
    if (evidenceByArm.has(arm)) continue;
    const monitor = new ProcessGroupMonitor(input.runtime.launcher);
    const diff = observeDiff(baselines[arm], monitor);
    const cancelled = {
      status: "failed",
      failure: {
        kind: "harness_confounded",
        reason: "paired_block_cancelled_before_launch",
        countsTowardReliability: false,
      },
    };
    const item = observation({
      cell: input.cell,
      arm,
      wallTimeMs: 0,
      outcome: cancelled,
      oracle: null,
    });
    evidenceByArm.set(arm, Object.freeze({
      arm,
      blindId: sha256(`${input.cell.blockId}\0${arm}`),
      status: item.executionStatus,
      failure: failureFrom(cancelled),
      diff,
      oracle: null,
      observation: item,
    }));
  }

  const sourceAfter = verifySourceReceipt(
    input.caseDefinition.repositoryPath,
    input.prepared.sourceReceiptBefore,
  );
  if (!sourceAfter.unchanged) throw new Error("source repository mutated during paired execution");
  const arms = Object.freeze([evidenceByArm.get("A")!, evidenceByArm.get("B")!]);
  if (arms.some((arm) => !arm)) throw new Error("paired execution did not produce both arms");
  const observations = Object.freeze(arms.map((arm) => arm.observation));
  const evidence: PairedBenchmarkEvidence = Object.freeze({
    schemaVersion: "agent-collab-paired-cell-v2",
    blockId: input.cell.blockId,
    caseId: input.cell.caseId,
    frozenInputs: Object.freeze({
      taskHash: sha256(input.caseDefinition.prompt),
      effort: input.cell.effort,
      limitsHash: sha256(canonicalJson(input.limits)),
      seededImageHash: input.prepared.seededImageHash,
      oracleHash: input.caseDefinition.oracleHash,
      manifestHash: input.runManifestHash,
    }),
    sourceUnchanged: true,
    arms,
  });
  const paths = {
    root: pairRoot,
    observations: join(pairRoot, "observations.json"),
    evidence: join(pairRoot, "blind-evidence.json"),
    mapping: join(pairRoot, "sealed-mapping.json"),
  } as const;
  atomicJson(paths.observations, observations);
  atomicJson(paths.evidence, evidence);
  atomicJson(paths.mapping, {
    schemaVersion: "agent-collab-paired-cell-mapping-v1",
    blockId: input.cell.blockId,
    launchOrder: input.cell.launchOrder,
    arms: (["A", "B"] as const).map((arm) => ({
      arm,
      blindId: evidenceByArm.get(arm)!.blindId,
      provider: armProviders[arm],
      policyId: arm === "A" ? input.cell.armA.policyId : input.cell.armB.policyId,
    })),
  });
  return Object.freeze({ observations, evidence, artifactPaths: Object.freeze(paths) });
}
