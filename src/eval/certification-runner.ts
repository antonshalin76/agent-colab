import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  createCertificationReceipt,
  type CertificationBinding,
  type CertificationCheck,
  type CertificationReceipt,
} from "./certification.js";
import type { LockedCorpus } from "./corpus.js";
import { createOracleSandboxExecutor } from "./oracle-sandbox.js";
import { EVALUATOR_IMPLEMENTATION_IDENTITY_HASH } from "./oracle-registry.js";
import { hashCanonicalJson } from "./run-manifest.js";
import { createCertificationRunRoot } from "./run-root.js";
import { captureSkillManifest, freezeSkillBundle } from "./skills.js";
import { captureSourceReceipt, verifySourceReceipt, type SourceReceipt } from "./snapshot.js";

const execFileAsync = promisify(execFile);

const FUNCTIONAL_TOOL_PROFILE = Object.freeze({
  allowed: ["read", "search", "edit", "bounded_local_test"],
  forbidden: ["web", "mcp", "subagents", "external_communication", "package_install"],
});

const ENVIRONMENT_CONTRACT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  PYTHONDONTWRITEBYTECODE: "1",
  PYTEST_ADDOPTS: "-p no:cacheprovider",
  history: "disabled",
  memory: "disabled",
});

const PROVIDER_COMMAND_PROFILE = Object.freeze({
  protocol: "agent-collab/v2",
  codex: { model: "gpt-5.6-sol", efforts: ["medium", "high", "xhigh"] },
  grok: { model: "grok-4.6", efforts: ["medium", "high", "xhigh"] },
});

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith("/"));
}

function implementationFiles(projectRoot: string): string[] {
  const roots = [
    join(projectRoot, "src", "eval"),
    join(projectRoot, "src", "runners", "codex.ts"),
    join(projectRoot, "src", "runners", "grok.ts"),
    join(projectRoot, "src", "runners", "provider-command.ts"),
    join(projectRoot, "tests"),
    join(projectRoot, "dist", "eval"),
    join(projectRoot, "dist", "runners", "codex.js"),
    join(projectRoot, "dist", "runners", "grok.js"),
    join(projectRoot, "dist", "runners", "provider-command.js"),
    join(projectRoot, "package.json"),
    join(projectRoot, "package-lock.json"),
    join(projectRoot, "tsconfig.json"),
    join(projectRoot, "tsconfig.test.json"),
  ];
  const files: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) throw new Error(`harness implementation artifact is missing: ${path}`);
    const stat = statSync(path);
    if (stat.isFile()) {
      if (!inside(projectRoot, path)) throw new Error("harness implementation path escapes project root");
      files.push(realpathSync(path));
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      visit(join(path, entry.name));
    }
  };
  roots.forEach(visit);
  return [...new Set(files)].sort();
}

export function captureHarnessImplementationHash(projectRoot: string): string {
  const root = realpathSync(projectRoot);
  const digest = createHash("sha256");
  for (const file of implementationFiles(root)) {
    digest.update(relative(root, file).split(sep).join("/"));
    digest.update("\0");
    digest.update(readFileSync(file));
    digest.update("\0");
  }
  return digest.digest("hex");
}

export function createCertificationBinding(input: {
  projectRoot: string;
  locked: LockedCorpus;
  skillBundleHash: string;
  sourceReceipts: Readonly<Record<string, SourceReceipt>>;
  machineProfile: Readonly<Record<string, unknown>>;
}): CertificationBinding {
  return {
    version: "agent-collab-eval-binding-v1",
    harnessImplementationHash: captureHarnessImplementationHash(input.projectRoot),
    corpusHash: input.locked.hashes.corpus,
    suiteHash: input.locked.hashes.suite,
    evaluatorImplementationHash: EVALUATOR_IMPLEMENTATION_IDENTITY_HASH,
    skillBundleHash: input.skillBundleHash,
    functionalToolProfileHash: hashCanonicalJson(FUNCTIONAL_TOOL_PROFILE),
    environmentContractHash: hashCanonicalJson(ENVIRONMENT_CONTRACT),
    providerCommandProfileHash: hashCanonicalJson(PROVIDER_COMMAND_PROFILE),
    sourceReceiptsHash: hashCanonicalJson(input.sourceReceipts),
    machineProfileHash: hashCanonicalJson(input.machineProfile),
  };
}

async function commandEvidence(input: {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}): Promise<{ passed: boolean; evidenceHash: string; detail: string }> {
  try {
    const result = await execFileAsync(input.file, input.args, {
      cwd: input.cwd,
      encoding: "utf8",
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
        HOME: homedir(),
      },
    });
    const evidence = `${result.stdout}\n${result.stderr}`;
    return { passed: true, evidenceHash: sha256(evidence), detail: "command completed with exit code 0" };
  } catch (error) {
    const caught = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    const evidence = `${caught.stdout ?? ""}\n${caught.stderr ?? ""}\n${caught.message}`;
    return {
      passed: false,
      evidenceHash: sha256(evidence),
      detail: `command failed: ${String(caught.code ?? "unknown").slice(0, 80)}`,
    };
  }
}

function check(
  id: string,
  evidence: { passed: boolean; evidenceHash: string; detail: string },
): CertificationCheck {
  return { id, ...evidence };
}

async function cppOracleRuntimeEvidence(root: string): Promise<ReturnType<typeof commandEvidence> extends Promise<infer T> ? T : never> {
  const workspace = join(root, "cpp-workspace");
  const oracle = join(root, "cpp-oracle");
  const scratch = join(root, "cpp-scratch");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(oracle, { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "probe.cpp"), "int main() { return 0; }\n", { mode: 0o600 });
  try {
    const execute = createOracleSandboxExecutor({
      workspaceRoot: workspace,
      oracleRoot: oracle,
      scratchRoot: scratch,
      maxOutputBytes: 256 * 1024,
      terminationGraceMs: 250,
      maxTimeoutMs: 30_000,
    });
    const compiled = await execute({
      file: "/usr/bin/c++",
      args: [
        "-fsanitize=address",
        "-fno-omit-frame-pointer",
        join(workspace, "probe.cpp"),
        "-o",
        join(scratch, "probe"),
      ],
      cwd: workspace,
      timeoutMs: 30_000,
      workspaceAccess: "read_only",
    });
    const ran = compiled.exitCode === 0
      ? await execute({
        file: join(scratch, "probe"),
        args: [],
        cwd: scratch,
        timeoutMs: 10_000,
        workspaceAccess: "read_only",
      })
      : null;
    const evidence = JSON.stringify({ compiled, ran });
    const passed = compiled.exitCode === 0 && compiled.cleanupVerified === true &&
      ran?.exitCode === 0 && ran.cleanupVerified === true;
    return {
      passed,
      evidenceHash: sha256(evidence),
      detail: passed ? "C++ ASan compile and execution passed in oracle sandbox" : "C++ ASan oracle smoke failed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, evidenceHash: sha256(message), detail: `C++ oracle smoke failed: ${message.slice(0, 200)}` };
  }
}

async function pythonOracleRuntimeEvidence(input: {
  root: string;
  pythonRuntimeRoot: string;
}): Promise<ReturnType<typeof commandEvidence> extends Promise<infer T> ? T : never> {
  const workspace = join(input.root, "python-workspace");
  const oracle = join(input.root, "python-oracle");
  const scratch = join(input.root, "python-scratch");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(oracle, { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const execute = createOracleSandboxExecutor({
      workspaceRoot: workspace,
      oracleRoot: oracle,
      scratchRoot: scratch,
      pythonRuntimeRoot: input.pythonRuntimeRoot,
      maxOutputBytes: 256 * 1024,
      terminationGraceMs: 250,
      maxTimeoutMs: 20_000,
    });
    const result = await execute({
      file: "/usr/bin/python3",
      args: ["-c", "import pydantic, pytest; print(pydantic.__version__); print(pytest.__version__)"],
      cwd: workspace,
      timeoutMs: 20_000,
      workspaceAccess: "read_only",
    });
    const evidence = JSON.stringify(result);
    const passed = result.exitCode === 0 && result.cleanupVerified === true &&
      result.stdout.trim().split("\n").length >= 2;
    return {
      passed,
      evidenceHash: sha256(evidence),
      detail: passed ? "Translator Python oracle dependencies imported in sandbox" : "Python oracle smoke failed",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, evidenceHash: sha256(message), detail: `Python oracle smoke failed: ${message.slice(0, 190)}` };
  }
}

export async function runHarnessCertification(input: {
  projectRoot: string;
  runRoot: string;
  locked: LockedCorpus;
  liveSkillRoot: string;
  machineProfile: Readonly<Record<string, unknown>>;
  pythonRuntimeRoot: string;
  createdAt?: string;
}): Promise<{ receipt: CertificationReceipt; receiptPath: string; bindingPath: string }> {
  const projectRoot = realpathSync(input.projectRoot);
  const runRoot = createCertificationRunRoot({
    runRoot: input.runRoot,
    protectedRoots: [projectRoot, ...input.locked.cases.map((item) => item.repositoryPath)],
  });
  const receiptPath = join(runRoot, "harness-certification.json");
  const bindingPath = join(runRoot, "certification-binding.json");
  if (existsSync(receiptPath) || existsSync(bindingPath)) {
    throw new Error("harness certification root already contains terminal artifacts");
  }

  const sourceReceipts = Object.fromEntries([...new Set(input.locked.cases.map((item) => item.repository))]
    .map((repository) => {
      const item = input.locked.cases.find((candidate) => candidate.repository === repository)!;
      return [repository, captureSourceReceipt(item.repositoryPath)];
    }));
  const frozenSkillRoot = join(runRoot, "frozen-skills");
  let skillEvidence: Awaited<ReturnType<typeof commandEvidence>>;
  let frozenSkillHash = "0".repeat(64);
  try {
    const live = captureSkillManifest({ root: input.liveSkillRoot, skills: [...input.locked.skills] });
    const frozen = freezeSkillBundle({
      sourceRoot: input.liveSkillRoot,
      destinationRoot: frozenSkillRoot,
      skills: [...input.locked.skills],
    });
    frozenSkillHash = frozen.hash;
    const passed = live.hash === frozen.hash && JSON.stringify(live.files) === JSON.stringify(frozen.files);
    skillEvidence = {
      passed,
      evidenceHash: sha256(JSON.stringify({ live, frozen })),
      detail: passed ? "one shared skill manifest was frozen byte-for-byte" : "shared skill freeze mismatch",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    skillEvidence = { passed: false, evidenceHash: sha256(message), detail: `skill freeze failed: ${message.slice(0, 210)}` };
  }

  const binding = createCertificationBinding({
    projectRoot,
    locked: input.locked,
    skillBundleHash: frozenSkillHash,
    sourceReceipts,
    machineProfile: input.machineProfile,
  });
  writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  const vitest = join(projectRoot, "node_modules", "vitest", "vitest.mjs");
  const grouped = await commandEvidence({
    file: process.execPath,
    args: [vitest, "run",
      "tests/eval-certification.test.ts",
      "tests/eval-core.test.ts",
      "tests/eval-corpus.test.ts",
      "tests/eval-provider.test.ts",
      "tests/eval-oracle-sandbox.test.ts",
      "tests/eval-run-manifest.test.ts",
      "tests/eval-benchmark-runner.test.ts",
      "tests/eval-scoring-validity.test.ts",
      "tests/eval-experiment.test.ts",
      "tests/eval-oracle-registry.test.ts",
      "tests/grok-v2.test.ts"],
    cwd: projectRoot,
    timeoutMs: 180_000,
  });
  const typecheck = await commandEvidence({
    file: process.execPath,
    args: [join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.json"],
    cwd: projectRoot,
    timeoutMs: 120_000,
  });
  const deterministic = {
    passed: grouped.passed && typecheck.passed,
    evidenceHash: sha256(JSON.stringify({ grouped, typecheck })),
    detail: grouped.passed && typecheck.passed
      ? "focused deterministic suites and static typecheck passed"
      : "focused deterministic suites or static typecheck failed",
  };
  const cliJson = await commandEvidence({
    file: process.execPath,
    args: [
      "-e",
      [
        "const {spawnSync}=require('node:child_process');",
        "const r=spawnSync(process.execPath,[process.argv[1],'schedule',process.argv[2],'measurement'],{encoding:'utf8',maxBuffer:16*1024*1024});",
        "if(r.status!==0) throw new Error(r.stderr||'schedule failed');",
        "const parsed=JSON.parse(r.stdout);",
        "if(parsed.mode!=='measurement'||!Array.isArray(parsed.rows)||parsed.rows.length===0) throw new Error('invalid measurement schedule');",
      ].join(""),
      join(projectRoot, "dist", "eval", "cli.js"),
      input.locked.corpusPath,
    ],
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  const cpp = await cppOracleRuntimeEvidence(join(runRoot, "runtime-smoke"));
  const python = await pythonOracleRuntimeEvidence({
    root: join(runRoot, "runtime-smoke"),
    pythonRuntimeRoot: input.pythonRuntimeRoot,
  });

  const sourceUnchanged = Object.entries(sourceReceipts).every(([repository, receipt]) => {
    const item = input.locked.cases.find((candidate) => candidate.repository === repository)!;
    return verifySourceReceipt(item.repositoryPath, receipt).unchanged;
  });
  const sourceEvidence = {
    passed: sourceUnchanged,
    evidenceHash: sha256(JSON.stringify(sourceReceipts)),
    detail: sourceUnchanged ? "corpus locks resolved and source receipts remained unchanged" : "source changed during certification",
  };

  const checks: CertificationCheck[] = [
    check("corpus_and_source_locks", sourceEvidence),
    check("shared_skill_freeze", skillEvidence),
    check("provider_command_contracts", deterministic),
    check("provider_output_normalization", deterministic),
    check("containment_boundaries", deterministic),
    check("timeout_and_process_cleanup", deterministic),
    check("output_diff_file_process_budgets", deterministic),
    check("cpp_oracle_runtime", cpp),
    check("python_oracle_runtime", python),
    check("cli_json_transport", cliJson),
    check("terminal_persistence_and_resume", deterministic),
    check("blind_mapping_and_scoring", deterministic),
    check("failure_classification", deterministic),
  ];
  const receipt = createCertificationReceipt({
    stage: "harness",
    createdAt: input.createdAt ?? new Date().toISOString(),
    binding,
    prerequisiteReceiptHashes: [],
    checks,
  });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { receipt, receiptPath, bindingPath };
}

export function defaultMachineProfile(input: {
  grokVersion: string;
  codexVersion: string;
  grokModelsHash: string;
  codexAuthStatusHash: string;
  pythonRuntimeRoot: string;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    node: process.version,
    bubblewrap: existsSync("/usr/bin/bwrap"),
    grokVersion: input.grokVersion,
    codexVersion: input.codexVersion,
    grokModelsHash: input.grokModelsHash,
    codexAuthStatusHash: input.codexAuthStatusHash,
    pythonRuntimeRoot: realpathSync(input.pythonRuntimeRoot),
  });
}

export const certificationProfileIdentity = Object.freeze({
  functionalTools: FUNCTIONAL_TOOL_PROFILE,
  environment: ENVIRONMENT_CONTRACT,
  providerCommands: PROVIDER_COMMAND_PROFILE,
});
