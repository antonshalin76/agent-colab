#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCanary } from "./canary-runner.js";
import {
  createCertificationBinding,
  defaultMachineProfile,
  runHarnessCertification,
} from "./certification-runner.js";
import { validateCertificationChain, type CertificationBinding } from "./certification.js";
import {
  deriveCorpusSuite,
  loadLockedCorpus,
  prepareCorpusCase,
  type LockedCorpus,
} from "./corpus.js";
import {
  providerCertificationBlockers,
  runProviderCertification,
} from "./provider-certification-runner.js";
import { hashCanonicalJson } from "./run-manifest.js";
import { createCanarySchedule, createExperimentSchedule, type ExperimentCell } from "./schedule.js";
import { captureSkillManifest } from "./skills.js";
import { captureSourceReceipt } from "./snapshot.js";

const defaultCorpus = resolve("evals", "punto-translator-v1", "corpus.json");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const action = process.argv[2] ?? "help";
const corpusPath = resolve(process.argv[3] ?? defaultCorpus);
const sha256 = (value: unknown): string => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value))
  .digest("hex");

const run = (file: string, args: string[]): { ok: boolean; output: string } => {
  try {
    return {
      ok: true,
      output: execFileSync(file, args, {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    const caught = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const stderr = caught.stderr?.toString().trim() ?? "";
    return { ok: false, output: stderr || caught.message };
  }
};

const json = (value: unknown): never => {
  writeFileSync(1, `${JSON.stringify(value, null, 2)}\n`);
  process.exit(0);
};

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function currentCertificationContext(input: {
  locked: LockedCorpus;
  runRoot: string;
}): {
  binding: CertificationBinding;
  harness: ReturnType<typeof validateCertificationChain>["harness"];
  frozenSkillRoot: string;
  providers: Readonly<Record<"grok" | "codex", { binary: string; authFile: string }>>;
  sources: Readonly<Record<string, string>>;
} {
  const grokSkills = process.env.AGENT_COLLAB_GROK_SKILLS ?? join(homedir(), ".grok", "skills");
  const codexSkills = process.env.AGENT_COLLAB_CODEX_SKILLS ?? join(homedir(), ".codex", "skills");
  if (realpathSync(grokSkills) !== realpathSync(codexSkills)) {
    throw new Error("certification requires one canonical shared skill root");
  }
  const liveSkillManifest = captureSkillManifest({ root: grokSkills, skills: [...input.locked.skills] });
  const frozenSkillRoot = join(input.runRoot, "frozen-skills");
  const frozenSkillManifest = captureSkillManifest({ root: frozenSkillRoot, skills: [...input.locked.skills] });
  if (liveSkillManifest.hash !== frozenSkillManifest.hash) {
    throw new Error("certification binding drift: live and frozen skill bundles differ");
  }
  const grokBinary = process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok");
  const codexBinary = process.env.AGENT_COLLAB_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
  const grokVersion = run(grokBinary, ["--version"]);
  const grokModels = run(grokBinary, ["models"]);
  const codexVersion = run(codexBinary, ["--version"]);
  const codexAuth = run(codexBinary, ["login", "status"]);
  if (!grokVersion.ok || !grokModels.ok || !grokModels.output.includes("grok-4.6") ||
      !codexVersion.ok || !codexAuth.ok || !existsSync("/usr/bin/bwrap")) {
    throw new Error("certification prerequisites drifted or became unavailable");
  }
  const sources = Object.fromEntries([...new Set(input.locked.cases.map((item) => item.repository))]
    .map((repository) => {
      const item = input.locked.cases.find((candidate) => candidate.repository === repository)!;
      return [repository, item.repositoryPath];
    }));
  const sourceReceipts = Object.fromEntries(Object.entries(sources)
    .map(([repository, path]) => [repository, captureSourceReceipt(path)]));
  const translatorRepository = sources.translator;
  if (!translatorRepository) throw new Error("translator oracle runtime source is missing");
  const pythonRuntimeRoot = process.env.AGENT_COLLAB_TRANSLATOR_ORACLE_PYTHON_ROOT ??
    join(translatorRepository, "sidecar", ".venv");
  const binding = createCertificationBinding({
    projectRoot,
    locked: input.locked,
    skillBundleHash: frozenSkillManifest.hash,
    sourceReceipts,
    machineProfile: defaultMachineProfile({
      grokVersion: grokVersion.output,
      codexVersion: codexVersion.output,
      grokModelsHash: sha256(grokModels.output),
      codexAuthStatusHash: sha256(codexAuth.output),
      pythonRuntimeRoot,
    }),
  });
  const persistedBinding = readJson(join(input.runRoot, "certification-binding.json"));
  if (hashCanonicalJson(persistedBinding) !== hashCanonicalJson(binding)) {
    throw new Error("certification binding drifted after harness certification");
  }
  const chain = validateCertificationChain({
    binding,
    harness: readJson(join(input.runRoot, "harness-certification.json")),
  });
  return {
    binding,
    harness: chain.harness,
    frozenSkillRoot,
    providers: {
      grok: { binary: grokBinary, authFile: join(homedir(), ".grok", "auth.json") },
      codex: { binary: codexBinary, authFile: join(homedir(), ".codex", "auth.json") },
    },
    sources,
  };
}

const schedule = (locked: LockedCorpus, mode: "canary" | "measurement"): readonly ExperimentCell[] => {
  const selected = mode === "canary"
    ? locked.suite.cases.filter((item) => item.runnable).slice(0, 1)
    : locked.suite.cases;
  if (mode === "canary") {
    const item = selected[0];
    if (!item) return [];
    return createCanarySchedule({
      suiteId: locked.suite.id,
      seed: locked.suite.seed,
      case: {
        caseId: item.id,
        taskClass: item.category,
        stage: item.task.stageFamily,
        mode: "stage_pair",
        baselinePolicy: locked.suite.baselinePolicy,
      },
      providers: ["grok", "codex"],
    });
  }
  const rows = createExperimentSchedule({
    suiteId: locked.suite.id,
    seed: `${locked.suite.seed}:${mode}`,
    cases: selected.map((item) => ({
      caseId: item.id,
      taskClass: item.category,
      stage: item.task.stageFamily,
      mode: "stage_pair" as const,
      baselinePolicy: locked.suite.baselinePolicy,
    })),
    efforts: locked.suite.efforts,
    repetitions: locked.suite.repetitions,
    providers: ["grok", "codex"],
  });
  return rows;
};

if (action === "help") {
  process.stdout.write([
    "agent-collab-eval validate [corpus.json]",
    "agent-collab-eval lock [corpus.json]",
    "agent-collab-eval preflight [corpus.json]",
    "agent-collab-eval certify-harness [corpus.json] <run-root>",
    "agent-collab-eval certify-providers [corpus.json] <run-root> APPROVE_LIVE_PROVIDER_CERTIFICATION",
    "agent-collab-eval run-canary [corpus.json] <run-root> APPROVE_LIVE_CANARY",
    "agent-collab-eval run-measurement [corpus.json] <run-root> APPROVE_LIVE_MEASUREMENT",
    "agent-collab-eval schedule [corpus.json] [canary|measurement]",
    "agent-collab-eval prepare [corpus.json] <destination> [case-id ...]",
    "",
  ].join("\n"));
  process.exit(0);
}

if (action === "lock") {
  const derived = deriveCorpusSuite(corpusPath);
  const output = join(dirname(derived.corpusPath), "suite.json");
  writeFileSync(output, `${JSON.stringify(derived.suite, null, 2)}\n`, { mode: 0o600 });
  const locked = loadLockedCorpus(corpusPath);
  json({ locked: true, output, suiteHash: locked.hashes.suite });
}

const locked = loadLockedCorpus(corpusPath);

if (action === "validate") {
  json({
    valid: true,
    corpusPath: locked.corpusPath,
    corpusHash: locked.hashes.corpus,
    suiteHash: locked.hashes.suite,
    cases: locked.suite.cases.map((item) => item.id),
    efforts: locked.suite.efforts,
    repetitions: locked.suite.repetitions,
  });
}

if (action === "schedule") {
  const mode = process.argv[4] ?? "measurement";
  if (mode !== "canary" && mode !== "measurement") {
    throw new Error("schedule mode must be canary or measurement");
  }
  const selected = mode === "canary"
    ? locked.suite.cases.filter((item) => item.runnable).slice(0, 1)
    : locked.suite.cases;
  const efforts = mode === "canary" ? ["medium"] : locked.suite.efforts;
  const rows = schedule(locked, mode);
  const nonRunnable = selected.filter((item) => !item.runnable).map((item) => item.id);
  json({
    mode,
    efforts,
    repetitions: mode === "canary" ? 1 : locked.suite.repetitions,
    launchAllowed: nonRunnable.length === 0,
    blockers: nonRunnable.map((caseId) => ({ caseId, reason: "case_not_runnable" })),
    rows,
  });
}

if (action === "certify-harness") {
  const runRoot = resolve(process.argv[4] ?? "");
  if (!process.argv[4]) throw new Error("certify-harness requires an explicit run root");
  const grokSkills = process.env.AGENT_COLLAB_GROK_SKILLS ?? join(homedir(), ".grok", "skills");
  const codexSkills = process.env.AGENT_COLLAB_CODEX_SKILLS ?? join(homedir(), ".codex", "skills");
  if (realpathSync(grokSkills) !== realpathSync(codexSkills)) {
    throw new Error("harness certification requires one canonical shared skill root");
  }
  const grokBinary = process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok");
  const codexBinary = process.env.AGENT_COLLAB_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
  const grokVersion = run(grokBinary, ["--version"]);
  const grokModels = run(grokBinary, ["models"]);
  const codexVersion = run(codexBinary, ["--version"]);
  const codexAuth = run(codexBinary, ["login", "status"]);
  if (!grokVersion.ok || !grokModels.ok || !grokModels.output.includes("grok-4.6") ||
      !codexVersion.ok || !codexAuth.ok || !existsSync("/usr/bin/bwrap")) {
    throw new Error("non-live harness prerequisites failed; no provider request was launched");
  }
  const translatorRepository = locked.cases.find((item) => item.repository === "translator")
    ?.repositoryPath;
  if (!translatorRepository) throw new Error("translator oracle runtime source is missing");
  const pythonRuntimeRoot = process.env.AGENT_COLLAB_TRANSLATOR_ORACLE_PYTHON_ROOT ??
    join(translatorRepository, "sidecar", ".venv");
  const result = await runHarnessCertification({
    projectRoot,
    runRoot,
    locked,
    liveSkillRoot: realpathSync(grokSkills),
    pythonRuntimeRoot,
    machineProfile: defaultMachineProfile({
      grokVersion: grokVersion.output,
      codexVersion: codexVersion.output,
      grokModelsHash: sha256(grokModels.output),
      codexAuthStatusHash: sha256(codexAuth.output),
      pythonRuntimeRoot,
    }),
  });
  json({
    stage: "harness",
    status: result.receipt.status,
    launchAllowedForProviderCertification:
      result.receipt.status === "passed" && providerCertificationBlockers.length === 0,
    providerCertificationBlockers,
    receiptPath: result.receiptPath,
    bindingPath: result.bindingPath,
    receiptHash: result.receipt.receiptHash,
    liveProviderRequests: 0,
  });
}

if (action === "run-pilot") {
  throw new Error(
    "run-pilot is disabled: use certify-harness, certify-providers, run-canary, then run-measurement",
  );
}

if (action === "certify-providers") {
  const runRoot = resolve(process.argv[4] ?? "");
  if (!process.argv[4]) throw new Error("certify-providers requires the harness certification run root");
  if (process.argv[5] !== "APPROVE_LIVE_PROVIDER_CERTIFICATION") {
    throw new Error(
      "provider certification makes exactly one bounded request per provider; " +
      "pass APPROVE_LIVE_PROVIDER_CERTIFICATION explicitly",
    );
  }
  const context = currentCertificationContext({ locked, runRoot });
  const result = await runProviderCertification({
    runRoot,
    binding: context.binding,
    harnessReceiptHash: context.harness.receiptHash,
    frozenSkillRoot: context.frozenSkillRoot,
    providers: context.providers,
    sources: context.sources,
  });
  json({
    stage: "providers",
    status: result.receipt.status,
    launchAllowedForCanary: result.receipt.status === "passed",
    receiptPath: result.receiptPath,
    evidencePath: result.evidencePath,
    receiptHash: result.receipt.receiptHash,
    liveProviderRequests: 2,
  });
}

if (action === "run-canary") {
  const runRoot = resolve(process.argv[4] ?? "");
  if (!process.argv[4]) throw new Error("run-canary requires the completed certification run root");
  if (process.argv[5] !== "APPROVE_LIVE_CANARY") {
    throw new Error("canary makes exactly two provider requests; pass APPROVE_LIVE_CANARY explicitly");
  }
  const context = currentCertificationContext({ locked, runRoot });
  const providerReceipt = readJson(join(runRoot, "provider-certification.json"));
  const chain = validateCertificationChain({
    binding: context.binding,
    harness: context.harness,
    providers: providerReceipt,
  });
  const translatorRepository = context.sources.translator;
  if (!translatorRepository) throw new Error("translator oracle runtime source is missing");
  const result = await runCanary({
    runRoot,
    binding: context.binding,
    harnessReceiptHash: chain.harness.receiptHash,
    providerReceiptHash: chain.providers!.receiptHash,
    locked,
    frozenSkillRoot: context.frozenSkillRoot,
    providers: context.providers,
    pythonRuntimeRoot: process.env.AGENT_COLLAB_TRANSLATOR_ORACLE_PYTHON_ROOT ??
      join(translatorRepository, "sidecar", ".venv"),
  });
  json({
    stage: "canary",
    status: result.receipt.status,
    launchAllowedForMeasurement: result.receipt.status === "passed",
    receiptPath: result.receiptPath,
    manifestPath: result.manifestPath,
    receiptHash: result.receipt.receiptHash,
    pairedCells: 1,
    liveProviderRequests: 2,
    routingChanged: false,
  });
}

if (action === "run-measurement") {
  const runRoot = resolve(process.argv[4] ?? "");
  if (!process.argv[4]) throw new Error("run-measurement requires the completed certification run root");
  if (process.argv[5] !== "APPROVE_LIVE_MEASUREMENT") {
    throw new Error("measurement consumes provider capacity; pass APPROVE_LIVE_MEASUREMENT explicitly");
  }
  const context = currentCertificationContext({ locked, runRoot });
  const chain = validateCertificationChain({
    binding: context.binding,
    harness: context.harness,
    providers: readJson(join(runRoot, "provider-certification.json")),
    canary: readJson(join(runRoot, "canary-certification.json")),
  });
  const blockers = locked.suite.cases.filter((item) => !item.runnable).map((item) => item.id);
  if (blockers.length > 0) {
    throw new Error(
      `measurement blocked: executable hidden oracles are missing for ${blockers.join(", ")}; ` +
      `certified canary receipt ${chain.canary!.receiptHash} remains valid only for its bound harness`,
    );
  }
  throw new Error("measurement execution is fail-closed until the full-run persistence path is certified");
}

if (action === "preflight") {
  const grokSkills = process.env.AGENT_COLLAB_GROK_SKILLS ?? join(homedir(), ".grok", "skills");
  const codexSkills = process.env.AGENT_COLLAB_CODEX_SKILLS ?? join(homedir(), ".codex", "skills");
  const grokManifest = captureSkillManifest({ root: grokSkills, skills: [...locked.skills] });
  const codexManifest = captureSkillManifest({ root: codexSkills, skills: [...locked.skills] });
  const grokBinary = process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok");
  const codexBinary = process.env.AGENT_COLLAB_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
  const grokVersion = run(grokBinary, ["--version"]);
  const grokModels = run(grokBinary, ["models"]);
  const codexVersion = run(codexBinary, ["--version"]);
  const codexAuth = run(codexBinary, ["login", "status"]);
  const sources = Object.fromEntries(locked.cases.map((item) => [
    item.repository,
    captureSourceReceipt(item.repositoryPath),
  ]));
  const sharedSkills = realpathSync(grokSkills) === realpathSync(codexSkills)
    && grokManifest.hash === codexManifest.hash;
  const result = {
    readyForDeterministicPreparation: sharedSkills
      && grokVersion.ok && grokModels.ok && grokModels.output.includes("grok-4.6")
      && codexVersion.ok && codexAuth.ok && existsSync("/usr/bin/bwrap"),
    liveProviderCapacityVerified: false,
    note: "Preflight is non-live; quota and current request capacity require an explicit bounded live probe.",
    providers: {
      grok: { binary: grokBinary, version: grokVersion, models: grokModels },
      codex: { binary: codexBinary, version: codexVersion, auth: codexAuth },
    },
    skills: {
      shared: sharedSkills,
      resolvedRoot: grokManifest.resolvedRoot,
      grokHash: grokManifest.hash,
      codexHash: codexManifest.hash,
      files: grokManifest.files.length,
    },
    containment: { bubblewrap: existsSync("/usr/bin/bwrap") },
    sources,
  };
  json(result);
}

if (action === "prepare") {
  const destination = resolve(process.argv[4] ?? "");
  if (!process.argv[4]) throw new Error("prepare requires an explicit destination outside source repositories");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const requested = process.argv.slice(5);
  const caseIds = requested.length > 0 ? requested : locked.cases.map((item) => item.id);
  const prepared = caseIds.map((caseId) => prepareCorpusCase({
    locked,
    caseId,
    destinationRoot: destination,
  }));
  json({ destination, prepared });
}

throw new Error(`unknown eval command: ${action}`);
