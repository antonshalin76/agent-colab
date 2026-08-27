import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runPairedBenchmarkCell,
  type PairedBenchmarkRuntime,
} from "../src/eval/benchmark-runner.js";
import { captureSourceReceipt, hashSnapshotTree } from "../src/eval/snapshot.js";
import type { PreparedCorpusCase } from "../src/eval/corpus.js";
import type {
  EvalLaunchedProcess,
  EvalProcessLauncher,
  EvalProcessResult,
} from "../src/eval/provider.js";
import type { CommandSpec } from "../src/runners/provider-command.js";
import type { ExperimentCell } from "../src/eval/schedule.js";

const roots: string[] = [];

function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function initializeSource(path: string): void {
  mkdirSync(join(path, "sidecar", "translator_sidecar"), { recursive: true });
  writeFileSync(join(path, "sidecar", "translator_sidecar", "provider_engine.py"), "original\n");
  writeFileSync(join(path, ".gitignore"), "build/\n");
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", [
    "-c", "user.name=Eval Fixture", "-c", "user.email=eval@example.invalid",
    "commit", "-qm", "fixture",
  ], { cwd: path });
}

function copyFixture(source: string, destination: string): void {
  mkdirSync(join(destination, "sidecar", "translator_sidecar"), { recursive: true });
  writeFileSync(
    join(destination, "sidecar", "translator_sidecar", "provider_engine.py"),
    readFileSync(join(source, "sidecar", "translator_sidecar", "provider_engine.py")),
  );
  writeFileSync(join(destination, ".gitignore"), readFileSync(join(source, ".gitignore")));
}

function createProviderRuntime(base: string): PairedBenchmarkRuntime["providers"] {
  const codexRoot = join(base, "codex-package");
  const codexBinary = join(codexRoot, "bin", "codex");
  const codexNative = join(
    codexRoot,
    "node_modules", "@openai", "codex-linux-x64", "vendor",
    "x86_64-unknown-linux-musl", "bin", "codex",
  );
  const grokBinary = join(base, "bin", "grok");
  const codexAuth = join(base, "codex-auth.json");
  const grokAuth = join(base, "grok-auth.json");
  for (const path of [codexBinary, codexNative, grokBinary]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  writeFileSync(codexAuth, "{}\n");
  writeFileSync(grokAuth, "{}\n");
  return {
    codex: { binary: codexBinary, authFile: codexAuth },
    grok: { binary: grokBinary, authFile: grokAuth },
  };
}

function cell(launchOrder: readonly ["grok" | "codex", "grok" | "codex"]): ExperimentCell {
  const baseline = Object.freeze({ tdd_coding: "codex" as const });
  const swapped = Object.freeze({ tdd_coding: "grok" as const });
  return Object.freeze({
    blockId: "a".repeat(64),
    caseId: "TR-BUG-01",
    taskClass: "bug",
    stage: "tdd_coding",
    effort: "high",
    repetition: 0,
    mode: "stage_pair",
    pairIdentity: Object.freeze({
      suiteId: "pilot",
      caseId: "TR-BUG-01",
      stage: "tdd_coding",
      effort: "high",
      policyId: "baseline:swapped",
      repetition: 0,
    }),
    launchOrder,
    armA: Object.freeze({ provider: "codex", policyId: "baseline", policy: baseline }),
    armB: Object.freeze({ provider: "grok", policyId: "swapped", policy: swapped }),
  });
}

function codexOutput(): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "reasoning", text: "PRIVATE_CODEX_TRANSCRIPT" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          protocolVersion: "agent-collab/v2",
          reasoningEffort: "high",
          visibleText: "implemented",
        }),
      },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
  ].join("\n") + "\n";
}

function grokOutput(): string {
  return JSON.stringify({
    stopReason: "end_turn",
    sessionId: "11111111-1111-4111-8111-111111111111",
    modelUsage: {
      "grok-4.6": {
        inputTokens: 11,
        outputTokens: 6,
        reasoningTokens: 2,
        totalTokens: 17,
        costUSD: 0.01,
      },
    },
    text: JSON.stringify({
      protocolVersion: "agent-collab/v2",
      reasoningEffort: "high",
      visibleText: "implemented",
    }),
    thought: "PRIVATE_GROK_TRANSCRIPT",
  });
}

class MutatingLauncher implements EvalProcessLauncher {
  readonly launches: Array<{ provider: "grok" | "codex"; command: CommandSpec }> = [];

  launch(command: CommandSpec): EvalLaunchedProcess {
    const provider = command.args.includes("/opt/agent-collab/bin/grok") ? "grok" : "codex";
    this.launches.push({ provider, command });
    writeFileSync(
      join(command.cwd, "sidecar", "translator_sidecar", "provider_engine.py"),
      `${provider} fix\n`,
    );
    mkdirSync(join(command.cwd, "build"), { recursive: true });
    writeFileSync(join(command.cwd, "build", "generated.bin"), Buffer.alloc(128_000, 1));
    const result: EvalProcessResult = {
      exitCode: 0,
      stdout: provider === "grok" ? grokOutput() : codexOutput(),
      stderr: "",
    };
    return {
      result: Promise.resolve(result),
      terminateGroup: vi.fn(),
      isProcessGroupAlive: () => false,
    };
  }
}

function fixture() {
  const base = root("agent-collab-paired-runner-");
  const source = join(base, "source");
  const armA = join(base, "arm-a");
  const armB = join(base, "arm-b");
  const artifacts = join(base, "artifacts");
  const skills = join(base, "skills");
  const oracle = join(base, "TR-BUG-01.py");
  mkdirSync(source);
  mkdirSync(armA);
  mkdirSync(armB);
  mkdirSync(skills);
  initializeSource(source);
  copyFixture(source, armA);
  copyFixture(source, armB);
  writeFileSync(oracle, "ORACLE_SECRET_SENTINEL\n");
  const oracleSha256 = createHash("sha256").update(readFileSync(oracle)).digest("hex");
  const receipt = captureSourceReceipt(source);
  const imageHash = hashSnapshotTree(armA);
  const prepared = {
    disposition: "ready",
    launchAllowed: true,
    imageHash,
    grok: { path: armA, imageHash },
    codex: { path: armB, imageHash },
    sourceReceiptBefore: receipt,
    sourceReceiptAfter: receipt,
    caseId: "TR-BUG-01",
    seededImageHash: imageHash,
  } satisfies Extract<PreparedCorpusCase, { disposition: "ready" }>;
  return {
    base,
    source,
    artifacts,
    skills,
    oracle,
    oracleSha256,
    prepared,
    providers: createProviderRuntime(join(base, "runtime")),
  };
}

describe("executable paired benchmark cell", () => {
  it("runs provider-swapped arms in frozen order, evaluates blindly, and persists sanitized evidence", async () => {
    const setup = fixture();
    const launcher = new MutatingLauncher();
    const oracleExecute = vi.fn(async (request: { args: readonly string[] }) => ({
      exitCode: 0,
      stdout: request.args.some((argument) => argument.endsWith("TR-BUG-01.py"))
        ? JSON.stringify({
          protocolVersion: "agent-collab/translator-oracle/v1",
          checks: {
            terminalIdentityReleased: { passed: true, evidence: "released" },
            terminalSemanticsPreserved: { passed: true, evidence: "preserved" },
          },
        })
        : "pass",
      stderr: "",
    }));
    const result = await runPairedBenchmarkCell({
      cell: cell(["grok", "codex"]),
      prepared: setup.prepared,
      caseDefinition: {
        id: "TR-BUG-01",
        repositoryPath: setup.source,
        prompt: "Fix the seeded terminal-state leak without reading hidden evaluation files.",
        oracleHash: "b".repeat(64),
        oraclePaths: [setup.oracle],
        oracleFiles: [{ path: "oracles/TR-BUG-01.py", sha256: setup.oracleSha256 }],
      },
      runManifestHash: "c".repeat(64),
      artifactRoot: setup.artifacts,
      skillRoot: setup.skills,
      runtime: {
        providers: setup.providers,
        launcher,
        oracleExecute,
        sessionId: () => "11111111-1111-4111-8111-111111111111",
      },
      limits: {
        wallTimeoutMs: 60_000,
        outputLimitBytes: 64_000,
        diffLimitBytes: 64_000,
        maxFiles: 4,
        maxProcesses: 8,
        terminationGraceMs: 10,
      },
    });

    expect(launcher.launches.map((launch) => launch.provider)).toEqual(["grok", "codex"]);
    expect(launcher.launches.map((launch) => JSON.parse(launch.command.stdin))).toEqual([
      expect.objectContaining({ reasoningEffort: "high", task: expect.stringContaining("terminal-state") }),
      expect.objectContaining({ reasoningEffort: "high", task: expect.stringContaining("terminal-state") }),
    ]);
    expect(launcher.launches.every((launch) =>
      !launch.command.stdin.includes("ORACLE_SECRET_SENTINEL") &&
      !launch.command.args.join(" ").includes(setup.oracle))).toBe(true);
    expect(oracleExecute).toHaveBeenCalledTimes(4);
    expect(result.observations.map((item) => [item.arm, item.deterministicQuality]))
      .toEqual([["A", 100], ["B", 100]]);
    expect(result.observations[0]?.usage.totalTokens).toEqual({
      value: 15,
      provenance: "provider_reported",
    });
    expect(result.observations[1]?.usage.costUsd).toEqual({
      value: 0.01,
      provenance: "provider_reported",
    });
    expect(result.evidence.arms.every((arm) =>
      arm.diff.changedFiles.join() === "sidecar/translator_sidecar/provider_engine.py" &&
      arm.diff.bytes > 0 && /^[a-f0-9]{64}$/.test(arm.diff.sha256))).toBe(true);
    expect(existsSync(join(setup.prepared.grok.path, ".git"))).toBe(false);
    expect(existsSync(join(setup.prepared.codex.path, ".git"))).toBe(false);
    expect(captureSourceReceipt(setup.source)).toEqual(setup.prepared.sourceReceiptBefore);

    const artifactFiles = readdirSync(result.artifactPaths.root);
    expect(artifactFiles).toEqual(expect.arrayContaining([
      "blind-evidence.json", "observations.json", "sealed-mapping.json",
    ]));
    const persisted = artifactFiles
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileSync(join(result.artifactPaths.root, name), "utf8"))
      .join("\n");
    expect(persisted).not.toMatch(/PRIVATE_(?:CODEX|GROK)_TRANSCRIPT|ORACLE_SECRET_SENTINEL/);
    expect(JSON.parse(readFileSync(result.artifactPaths.mapping, "utf8"))).toMatchObject({
      launchOrder: ["grok", "codex"],
      arms: [{ arm: "A", provider: "codex" }, { arm: "B", provider: "grok" }],
    });
    expect(JSON.parse(readFileSync(result.artifactPaths.evidence, "utf8")).arms[0])
      .not.toHaveProperty("provider");
  });

  it("does not invoke the hidden oracle when a provider attempt fails", async () => {
    const setup = fixture();
    const launcher: EvalProcessLauncher = {
      launch: () => ({
        result: Promise.resolve({ exitCode: 2, stdout: "", stderr: "task failed" }),
        terminateGroup: vi.fn(),
        isProcessGroupAlive: () => false,
      }),
    };
    const oracleExecute = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const result = await runPairedBenchmarkCell({
      cell: cell(["codex", "grok"]),
      prepared: setup.prepared,
      caseDefinition: {
        id: "TR-BUG-01",
        repositoryPath: setup.source,
        prompt: "Fix the bug.",
        oracleHash: "b".repeat(64),
        oraclePaths: [setup.oracle],
        oracleFiles: [{ path: "oracles/TR-BUG-01.py", sha256: setup.oracleSha256 }],
      },
      runManifestHash: "c".repeat(64),
      artifactRoot: setup.artifacts,
      skillRoot: setup.skills,
      runtime: {
        providers: setup.providers,
        launcher,
        oracleExecute,
        sessionId: () => "11111111-1111-4111-8111-111111111111",
      },
      limits: {
        wallTimeoutMs: 60_000,
        outputLimitBytes: 64_000,
        diffLimitBytes: 64_000,
        maxFiles: 4,
        maxProcesses: 8,
        terminationGraceMs: 10,
      },
    });

    expect(oracleExecute).not.toHaveBeenCalled();
    expect(result.observations.every((item) => item.executionStatus === "failed")).toBe(true);
    expect(result.observations.every((item) => item.deterministicQuality === 0)).toBe(true);
  });
});
