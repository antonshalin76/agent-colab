import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPairedBenchmarkCell } from "./benchmark-runner.js";
import {
  createCertificationReceipt,
  type CertificationBinding,
  type CertificationCheck,
  type CertificationReceipt,
} from "./certification.js";
import { prepareCorpusCase, type LockedCorpus } from "./corpus.js";
import { createOracleSandboxExecutor } from "./oracle-sandbox.js";
import { NodeEvalProcessLauncher } from "./provider.js";
import { hashCanonicalJson } from "./run-manifest.js";
import { createCanarySchedule } from "./schedule.js";
import { captureSkillManifest } from "./skills.js";
import { createCertificationSubdirectory, requireCertificationRunRoot } from "./run-root.js";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function check(id: string, passed: boolean, evidence: unknown, detail: string): CertificationCheck {
  return { id, passed, evidenceHash: sha256(JSON.stringify(evidence)), detail };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateCanaryOracleGating(input: readonly Readonly<{
  status: "completed" | "failed" | "invalidated";
  failure: Readonly<{ kind: string; reason: string }> | null;
  oracle: unknown | null;
}>[]): boolean {
  return input.length === 2 && input.every((arm) =>
    arm.status === "completed" && arm.failure === null && arm.oracle !== null);
}

export async function runCanary(input: {
  runRoot: string;
  binding: CertificationBinding;
  harnessReceiptHash: string;
  providerReceiptHash: string;
  locked: LockedCorpus;
  frozenSkillRoot: string;
  providers: Readonly<Record<"grok" | "codex", { binary: string; authFile: string }>>;
  pythonRuntimeRoot: string;
  createdAt?: string;
}): Promise<{ receipt: CertificationReceipt; receiptPath: string; manifestPath: string }> {
  const runRoot = requireCertificationRunRoot(input.runRoot);
  const receiptPath = join(runRoot, "canary-certification.json");
  const manifestPath = join(runRoot, "canary-manifest.json");
  if (existsSync(receiptPath) || existsSync(manifestPath)) {
    throw new Error("canary already has terminal artifacts");
  }
  const runnable = input.locked.suite.cases.find((item) => item.runnable);
  if (!runnable) throw new Error("canary requires at least one runnable corpus case");
  const definition = input.locked.cases.find((item) => item.id === runnable.id);
  if (!definition?.runnable) throw new Error("canary runnable case definition is missing");
  const cells = createCanarySchedule({
    suiteId: input.locked.suite.id,
    seed: input.locked.suite.seed,
    case: {
      caseId: runnable.id,
      taskClass: runnable.category,
      stage: runnable.task.stageFamily,
      mode: "stage_pair",
      baselinePolicy: input.locked.suite.baselinePolicy,
    },
    providers: ["grok", "codex"],
  });
  const cell = cells[0]!;
  const workspaceRoot = createCertificationSubdirectory(runRoot, "canary/workspace");
  const artifactRoot = createCertificationSubdirectory(runRoot, "canary/artifacts");
  const prepared = prepareCorpusCase({
    locked: input.locked,
    caseId: cell.caseId,
    destinationRoot: workspaceRoot,
  });
  if (prepared.disposition !== "ready") {
    throw new Error(`canary preparation is inconclusive: ${prepared.reason}`);
  }
  const skillManifest = captureSkillManifest({
    root: input.frozenSkillRoot,
    skills: [...input.locked.skills],
  });
  if (skillManifest.hash !== input.binding.skillBundleHash) {
    throw new Error("canary frozen skill bundle drifted from certification binding");
  }
  const manifestBody = {
    version: "agent-collab-eval-canary-manifest-v1",
    bindingHash: hashCanonicalJson(input.binding),
    prerequisites: [input.harnessReceiptHash, input.providerReceiptHash],
    cell,
    inputs: {
      corpusHash: input.locked.hashes.corpus,
      suiteHash: input.locked.hashes.suite,
      seededImageHash: prepared.seededImageHash,
      sourceRevision: definition.revision,
      sourceTreeHash: definition.treeHash,
      oracleHash: definition.oracleHash,
      skillBundleHash: skillManifest.hash,
    },
    providers: {
      codex: { model: "gpt-5.6-sol", effort: "medium" },
      grok: { model: "grok-4.6", effort: "medium" },
    },
    limits: input.locked.limits,
  } as const;
  const manifest = { ...manifestBody, manifestHash: hashCanonicalJson(manifestBody) };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  const result = await runPairedBenchmarkCell({
    cell,
    prepared,
    caseDefinition: definition,
    runManifestHash: manifest.manifestHash,
    artifactRoot,
    skillRoot: input.frozenSkillRoot,
    runtime: {
      providers: input.providers,
      launcher: new NodeEvalProcessLauncher(),
      oracleExecutor: ({ caseId, workspaceRoot: candidate, oracleRoot, scratchRoot }) =>
        createOracleSandboxExecutor({
          workspaceRoot: candidate,
          oracleRoot,
          scratchRoot,
          maxOutputBytes: input.locked.limits.outputLimitBytes,
          terminationGraceMs: 2_000,
          maxTimeoutMs: input.locked.limits.wallTimeoutMs,
          ...(caseId.startsWith("TR-") ? { pythonRuntimeRoot: input.pythonRuntimeRoot } : {}),
        }),
      allowProviderNetwork: true,
    },
    limits: {
      wallTimeoutMs: input.locked.limits.wallTimeoutMs,
      outputLimitBytes: input.locked.limits.outputLimitBytes,
      diffLimitBytes: input.locked.limits.diffLimitBytes,
      maxFiles: input.locked.limits.maxFiles,
      maxProcesses: input.locked.limits.maxProcesses,
      terminationGraceMs: 2_000,
    },
  });

  const mapping = readFileSync(result.artifactPaths.mapping, "utf8");
  const parsedMapping = record(JSON.parse(mapping));
  const mappingArms = Array.isArray(parsedMapping?.arms) ? parsedMapping.arms : [];
  const terminal = result.evidence.arms.length === 2 &&
    result.evidence.arms.every((arm) => ["completed", "failed", "invalidated"].includes(arm.status));
  const noHarnessFailure = result.evidence.arms.every((arm) =>
    arm.failure === null || arm.failure.kind === "execution_outcome");
  const oracleGatingPassed = validateCanaryOracleGating(result.evidence.arms);
  const parity = prepared.grok.imageHash === prepared.codex.imageHash &&
    prepared.seededImageHash === prepared.grok.imageHash &&
    manifest.inputs.skillBundleHash === input.binding.skillBundleHash;
  const pairedRoots = readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const checks: CertificationCheck[] = [
    check("single_paired_cell_only", pairedRoots.length === 1 && pairedRoots[0] === cell.blockId,
      pairedRoots, "canary launched exactly one paired cell with two provider requests"),
    check("manifest_and_arm_parity", parity, manifest,
      parity ? "canary manifest and both arm images match the certified binding" : "canary parity mismatch"),
    check("both_attempts_terminal", terminal, result.evidence.arms.map((arm) => arm.status),
      terminal ? "both canary attempts persisted terminal states" : "a canary attempt is not terminal"),
    check("source_immutability", result.evidence.sourceUnchanged === true, result.evidence.sourceUnchanged,
      "the live source repository remained unchanged"),
    check("blind_mapping_sealed", mappingArms.length === 2 &&
      new Set(mappingArms.map((item) => record(item)?.blindId)).size === 2,
      parsedMapping, "sealed mapping contains two unique opaque candidate labels"),
    check("hidden_oracle_gating", oracleGatingPassed,
      result.evidence.arms.map((arm) => ({
        status: arm.status,
        failure: arm.failure,
        oraclePresent: arm.oracle !== null,
      })),
      oracleGatingPassed
        ? "both hidden oracles ran after two successful provider attempts"
        : "both provider attempts must complete before hidden-oracle certification"),
    check("no_harness_failure", noHarnessFailure,
      result.evidence.arms.map((arm) => arm.failure),
      noHarnessFailure ? "canary produced no provider or harness invalidation" : "canary exposed a provider or harness failure"),
  ];
  const receipt = createCertificationReceipt({
    stage: "canary",
    createdAt: input.createdAt ?? new Date().toISOString(),
    binding: input.binding,
    prerequisiteReceiptHashes: [input.harnessReceiptHash, input.providerReceiptHash],
    checks,
  });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { receipt, receiptPath, manifestPath };
}
