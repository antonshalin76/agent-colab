import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentRunner,
  type ProcessLauncher,
  type ProcessResult,
  type ProcessTask,
} from "../src/runners/agent-runner.js";
import { projectMapLearning } from "../src/flow/map-admin.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { readQuarantinedProviderTelemetry } from "../src/runtime/provider-telemetry.js";
import { FlowTelemetryStore } from "../src/store/flow-telemetry-store.js";
import { RunStore } from "../src/store/run-store.js";
import { DurableWorker } from "../src/worker/durable-worker.js";
import { buildClaudeCommand } from "../src/runners/claude.js";
import { buildCodexCommand } from "../src/runners/codex.js";
import { buildGrokCommand } from "../src/runners/grok.js";
import type { CommandSpec } from "../src/runners/provider-command.js";
import {
  createTelemetryFixture,
  telemetryRows,
} from "./helpers/flow-telemetry-fixture.js";

type JsonObject = Record<string, unknown>;
type Provider = "codex" | "grok" | "claude";
type ProviderOutcome = "succeeded" | "provider_failure" | "timeout" | "malformed_terminal" | "pre_session_failure";
type UsageStatus = "exact" | "partial" | "unavailable" | "invalid_provider_usage";
type UsageField =
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningTokens"
  | "totalTokens"
  | "costUsd"
  | "costMicroUsd";

interface ProviderSessionRef extends JsonObject {
  value: string;
  provenance: "command_pinned" | "provider_reported";
}

interface NormalizedProviderUsage extends JsonObject {
  status: UsageStatus;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costMicroUsd: number | null;
  provenance: Record<UsageField, string>;
}

interface ProviderTerminalTelemetry extends JsonObject {
  schemaVersion: "ProviderTerminalTelemetry/v1";
  provider: Provider;
  providerSessionRef: ProviderSessionRef | null;
  outcome: ProviderOutcome;
  usage: NormalizedProviderUsage;
}

interface ProviderTelemetryRuntime {
  mapProviderTelemetryOutcome(input: {
    provider: "codex" | "grok" | "claude";
    providerSessionRef: { value: string; provenance: "command_pinned" | "provider_reported" } | null;
    outcome: "success" | "provider_failure" | "timeout" | "malformed_terminal" | "pre_session_failure";
    usageReport: unknown;
  }): ProviderTerminalTelemetry;
}

interface RunnerNormalizers {
  codex: {
    normalizeCodexResult(stdout: string, options: { includeUsage: true }): JsonObject;
  };
  grok: {
    normalizeGrokResult(stdout: string, options: JsonObject): JsonObject;
  };
  claude: {
    normalizeClaudeResult(stdout: string, options: JsonObject): JsonObject;
  };
}

const load = async (): Promise<{ telemetry: ProviderTelemetryRuntime; normalizers: RunnerNormalizers }> => {
  const [telemetry, codex, grok, claude] = await Promise.all([
    import(pathToFileURL(resolve("src/runtime/provider-telemetry.ts")).href),
    import(pathToFileURL(resolve("src/runners/codex.ts")).href),
    import(pathToFileURL(resolve("src/runners/grok.ts")).href),
    import(pathToFileURL(resolve("src/runners/claude.ts")).href),
  ]);
  return {
    telemetry: telemetry as unknown as ProviderTelemetryRuntime,
    normalizers: { codex, grok, claude } as unknown as RunnerNormalizers,
  };
};

const codexStdout = (usage: JsonObject = {
  input_tokens: 10,
  cached_input_tokens: 2,
  output_tokens: 5,
  reasoning_output_tokens: 1,
  total_tokens: 15,
  cost_usd: 0.0042,
}): string => [
  { type: "thread.started", thread_id: "codex-thread-1" },
  { type: "item.completed", item: { type: "agent_message", text: "done" } },
  { type: "turn.completed", usage },
].map((event) => JSON.stringify(event)).join("\n") + "\n";

const grokStdout = (usage: JsonObject = {
  inputTokens: 10,
  cacheReadInputTokens: 2,
  outputTokens: 5,
  reasoningTokens: 1,
  totalTokens: 15,
  costUSD: 0.0042,
}): string => JSON.stringify({
  text: "done",
  stopReason: "end_turn",
  sessionId: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
  structuredOutput: {
    protocolVersion: "agent-collab/v2",
    reasoningEffort: "high",
    visibleText: "done",
  },
  modelUsage: { "grok-4.6": usage },
});

const claudeStdout = (): string => JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "123e4567-e89b-42d3-a456-426614174000",
  result: JSON.stringify({ ok: true }),
  structured_output: { ok: true },
});

const RUNNER_PROJECT = process.cwd();
const BINARIES = {
  codex: "/opt/codex",
  grok: process.env.AGENT_COLLAB_GROK_BIN ?? join(homedir(), ".local", "bin", "grok"),
  claude: process.env.AGENT_COLLAB_CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude"),
} as const;
const MODELS = { codex: "gpt-5.6-sol", grok: "grok-4.6", claude: "glm-5.3" } as const;
const SESSION_IDS = {
  codex: "123e4567-e89b-42d3-a456-426614174010",
  grok: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
  claude: "123e4567-e89b-42d3-a456-426614174000",
} as const;
const roots: string[] = [];

const PROVIDER_TELEMETRY_KEYS = [
  "outcome", "provider", "providerSessionRef", "schemaVersion", "usage",
] as const;
const PROVIDER_SESSION_REF_KEYS = ["provenance", "value"] as const;
const NORMALIZED_USAGE_KEYS = [
  "cachedInputTokens", "costMicroUsd", "costUsd", "inputTokens", "outputTokens",
  "provenance", "reasoningTokens", "status", "totalTokens",
] as const;
const USAGE_PROVENANCE_KEYS = [
  "cachedInputTokens", "costMicroUsd", "costUsd", "inputTokens", "outputTokens",
  "reasoningTokens", "totalTokens",
] as const;

const unavailableProvenance = (): Record<UsageField, string> => ({
  inputTokens: "unavailable",
  cachedInputTokens: "unavailable",
  outputTokens: "unavailable",
  reasoningTokens: "unavailable",
  totalTokens: "unavailable",
  costUsd: "unavailable",
  costMicroUsd: "unavailable",
});

const unavailableUsage = (
  status: "unavailable" | "invalid_provider_usage" = "unavailable",
): NormalizedProviderUsage => ({
  status,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  costUsd: null,
  costMicroUsd: null,
  provenance: unavailableProvenance(),
});

const exactUsage = (): NormalizedProviderUsage => ({
  status: "exact",
  inputTokens: 10,
  cachedInputTokens: 2,
  outputTokens: 5,
  reasoningTokens: 1,
  totalTokens: 15,
  costUsd: 0.0042,
  costMicroUsd: 4_200,
  provenance: {
    inputTokens: "provider_reported",
    cachedInputTokens: "provider_reported",
    outputTokens: "provider_reported",
    reasoningTokens: "provider_reported",
    totalTokens: "provider_reported",
    costUsd: "provider_reported",
    costMicroUsd: "lossless_usd_to_microusd",
  },
});

const fractionalCostUsage = (): NormalizedProviderUsage => ({
  status: "partial",
  inputTokens: 1,
  cachedInputTokens: null,
  outputTokens: 2,
  reasoningTokens: null,
  totalTokens: null,
  costUsd: 0.0000005,
  costMicroUsd: null,
  provenance: {
    inputTokens: "provider_reported",
    cachedInputTokens: "unavailable",
    outputTokens: "provider_reported",
    reasoningTokens: "unavailable",
    totalTokens: "unavailable",
    costUsd: "provider_reported",
    costMicroUsd: "unavailable_fractional_microusd",
  },
});

function providerTelemetry(
  provider: Provider,
  providerSessionRef: ProviderSessionRef | null,
  outcome: ProviderOutcome,
  usage: NormalizedProviderUsage,
): ProviderTerminalTelemetry {
  return {
    schemaVersion: "ProviderTerminalTelemetry/v1",
    provider,
    providerSessionRef,
    outcome,
    usage,
  };
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function expectExactProviderTelemetry(
  actual: unknown,
  expected: ProviderTerminalTelemetry,
): void {
  const observation = jsonObject(actual, "provider telemetry observation");
  expect(Object.keys(observation).sort()).toEqual([...PROVIDER_TELEMETRY_KEYS].sort());
  if (observation.providerSessionRef !== null) {
    expect(Object.keys(jsonObject(observation.providerSessionRef, "provider session ref")).sort())
      .toEqual([...PROVIDER_SESSION_REF_KEYS].sort());
  }
  const usage = jsonObject(observation.usage, "normalized provider usage");
  expect(Object.keys(usage).sort()).toEqual([...NORMALIZED_USAGE_KEYS].sort());
  expect(Object.keys(jsonObject(usage.provenance, "usage provenance")).sort())
    .toEqual([...USAGE_PROVENANCE_KEYS].sort());
  expect(observation).toEqual(expected);
}

function expectQuarantinedRunnerResult(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  expectedObservation: ProviderTerminalTelemetry | null,
): void {
  expect(actual).toEqual(expected);
  expect(Object.getOwnPropertyNames(actual).sort()).toEqual(Object.keys(expected).sort());
  expect(Object.getOwnPropertySymbols(actual)).toEqual([]);
  expect("telemetryObservation" in actual).toBe(false);
  expect("providerSessionRef" in actual).toBe(false);
  expect("usage" in actual).toBe(false);
  expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
  expect(readQuarantinedProviderTelemetry(actual)).toEqual(expectedObservation);
}

function telemetryDomainRows(databasePath: string): Record<string, Array<Record<string, unknown>>> {
  const { runs: _runs, ...domainRows } = telemetryRows(databasePath);
  return domainRows;
}

const learningCache = new Map<Provider, {
  context: string;
  binding: { schemaVersion: "map-learning-launch-binding/v1"; consumer: Provider; projectionBase64: string; digest: string };
}>();

function runnerLearning(provider: Provider): {
  context: string;
  binding: { schemaVersion: "map-learning-launch-binding/v1"; consumer: Provider; projectionBase64: string; digest: string };
} {
  const cached = learningCache.get(provider);
  if (cached) return cached;
  const projection = projectMapLearning(RUNNER_PROJECT, provider).projection;
  const value = {
    context: `Promoted MAP learning projection for ${provider} (${projection.digest}):\n${Buffer.from(
      projection.bytes,
    ).toString("utf8").trimEnd()}`,
    binding: {
      schemaVersion: "map-learning-launch-binding/v1" as const,
      consumer: provider,
      projectionBase64: Buffer.from(projection.bytes).toString("base64"),
      digest: projection.digest,
    },
  };
  learningCache.set(provider, value);
  return value;
}

function runnerTask(provider: Provider): ProcessTask {
  const sessionId = SESSION_IDS[provider];
  const attemptId = `review:attempt:0:${provider}:routing-v5`;
  const dispatchId = `review:dispatch:${provider}:0`;
  const decision = {
    agent: provider,
    model: MODELS[provider],
    effort: "high",
    policyVersion: "routing-v5",
    reasons: ["stage_baseline:code_audit:high"],
  } as const;
  const learning = runnerLearning(provider);
  return {
    id: `run-${provider}`,
    stage: "review:auditor",
    artifactHash: "a".repeat(64),
    idempotencyKey: dispatchId,
    approvalScope: "workspace-read",
    payload: {
      project: RUNNER_PROJECT,
      prompt: `${learning.context}\n\nreview`,
      approvalScope: "workspace-read",
      requester: "codex",
      reviewAttemptId: attemptId,
      reviewAttemptOrdinal: 0,
      reviewDispatchId: dispatchId,
      sourceFingerprint: captureWorkspaceFingerprint(RUNNER_PROJECT).fingerprint,
      mapLearning: learning.binding,
      decision,
      sessionId,
      reviewDispatchIdentity: {
        ...decision,
        sessionId,
        attemptId,
        attemptOrdinal: 0,
        degraded: false,
      },
    },
  };
}

function runnerWith(
  launch: ProcessLauncher["launch"],
  timeoutMs = 90_000,
): AgentRunner {
  return new AgentRunner({ binaries: BINARIES, timeoutMs, launcher: { launch } });
}

function expectReadOnlyCommand(command: CommandSpec, provider: Provider): void {
  expect(command).toMatchObject({
    file: BINARIES[provider],
    cwd: RUNNER_PROJECT,
    shell: false,
    killProcessGroup: true,
  });
  expect(command.args).not.toContain("includeUsage");
  expect(command.args.join(" ")).not.toMatch(/include.?usage/i);
  if (provider === "codex") {
    expect(command.args.slice(command.args.indexOf("-s"), command.args.indexOf("-s") + 2))
      .toEqual(["-s", "read-only"]);
  } else if (provider === "grok") {
    expect(command.args.slice(command.args.indexOf("--sandbox"), command.args.indexOf("--sandbox") + 2))
      .toEqual(["--sandbox", "strict"]);
    expect(command.args.slice(command.args.indexOf("--permission-mode"), command.args.indexOf("--permission-mode") + 2))
      .toEqual(["--permission-mode", "dontAsk"]);
  } else {
    expect(command.args).toContain("--safe-mode");
    expect(command.args.slice(command.args.indexOf("--permission-mode"), command.args.indexOf("--permission-mode") + 2))
      .toEqual(["--permission-mode", "dontAsk"]);
  }
}

function expectSavedRouting(
  callback: ReturnType<typeof vi.fn>,
  phase: "launching" | "started",
  provider: Provider,
  pid?: number,
): void {
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback.mock.calls).toEqual([[
    {
      phase,
      ...(phase === "started" ? { pid } : {}),
      agent: provider,
      model: MODELS[provider],
      effort: "high",
      policyVersion: "routing-v5",
      sessionId: SESSION_IDS[provider],
    },
  ]]);
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider terminal telemetry transport", () => {
  it("preserves Codex and Grok provider sessions and safe usage through the one neutral mapper", async () => {
    const { telemetry, normalizers } = await load();
    const codex = normalizers.codex.normalizeCodexResult(codexStdout(), { includeUsage: true });
    const codexSession = { value: "codex-thread-1", provenance: "provider_reported" } as const;
    expect(codex.providerSessionRef).toEqual(codexSession);
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "codex",
      providerSessionRef: codex.providerSessionRef as {
        value: string; provenance: "provider_reported";
      },
      outcome: "success",
      usageReport: codex.usage,
    }), providerTelemetry("codex", codexSession, "succeeded", exactUsage()));

    const grok = normalizers.grok.normalizeGrokResult(grokStdout(), {
      expectedEffort: "high",
      expectedProtocolVersion: "agent-collab/v2",
      expectedSessionId: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
      includeUsage: true,
    });
    const grokSession = {
      value: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
      provenance: "command_pinned",
    } as const;
    expect(grok.providerSessionRef).toEqual(grokSession);
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "grok",
      providerSessionRef: grok.providerSessionRef as {
        value: string; provenance: "command_pinned";
      },
      outcome: "success",
      usageReport: grok.usage,
    }), providerTelemetry("grok", grokSession, "succeeded", exactUsage()));
  });

  it("maps absent Claude usage, fractional cost, invalid usage, and transport failures truthfully", async () => {
    const { telemetry, normalizers } = await load();
    const claude = normalizers.claude.normalizeClaudeResult(claudeStdout(), {
      expectedSessionId: "123e4567-e89b-42d3-a456-426614174000",
      expectedEffort: "high",
    });
    const claudeSession = {
      value: "123e4567-e89b-42d3-a456-426614174000",
      provenance: "command_pinned",
    } as const;
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "claude",
      providerSessionRef: { value: String(claude.sessionId), provenance: "command_pinned" },
      outcome: "success",
      usageReport: null,
    }), providerTelemetry("claude", claudeSession, "succeeded", unavailableUsage()));
    const grokSession = { value: "grok-session", provenance: "provider_reported" } as const;
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "grok",
      providerSessionRef: grokSession,
      outcome: "success",
      usageReport: { inputTokens: 1, outputTokens: 2, costUsd: 0.0000005 },
    }), providerTelemetry("grok", grokSession, "succeeded", fractionalCostUsage()));
    const codexSession = { value: "codex-thread", provenance: "provider_reported" } as const;
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "codex",
      providerSessionRef: codexSession,
      outcome: "success",
      usageReport: { inputTokens: 1.5, outputTokens: 2, costUsd: 0.0042 },
    }), providerTelemetry("codex", codexSession, "succeeded", unavailableUsage("invalid_provider_usage")));

    for (const outcome of ["provider_failure", "timeout", "malformed_terminal"] as const) {
      expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
        provider: "codex",
        providerSessionRef: codexSession,
        outcome,
        usageReport: null,
      }), providerTelemetry("codex", codexSession, outcome, unavailableUsage()));
    }
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "codex",
      providerSessionRef: null,
      outcome: "pre_session_failure",
      usageReport: null,
    }), providerTelemetry("codex", null, "pre_session_failure", unavailableUsage()));
  });

  it("keeps unsafe provider scalars intact until the central validator classifies the entire observation", async () => {
    const { telemetry, normalizers } = await load();
    const unsafeCodex = normalizers.codex.normalizeCodexResult(codexStdout({
      input_tokens: 1.5,
      output_tokens: 2,
      cost_usd: 0.0042,
    }), { includeUsage: true });
    expect(unsafeCodex.usage).toEqual({
      inputTokens: 1.5,
      cachedInputTokens: null,
      outputTokens: 2,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: 0.0042,
      provenance: {
        inputTokens: "provider_reported",
        cachedInputTokens: "unavailable",
        outputTokens: "provider_reported",
        reasoningTokens: "unavailable",
        totalTokens: "unavailable",
        costUsd: "provider_reported",
      },
    });
    const codexSession = { value: "codex-thread-1", provenance: "provider_reported" } as const;
    expect(unsafeCodex.providerSessionRef).toEqual(codexSession);
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "codex",
      providerSessionRef: unsafeCodex.providerSessionRef as {
        value: string; provenance: "provider_reported";
      },
      outcome: "success",
      usageReport: unsafeCodex.usage,
    }), providerTelemetry("codex", codexSession, "succeeded", unavailableUsage("invalid_provider_usage")));

    const unsafeGrok = normalizers.grok.normalizeGrokResult(grokStdout({
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      outputTokens: 2,
      costUSD: 0.0042,
    }), {
      expectedEffort: "high",
      expectedProtocolVersion: "agent-collab/v2",
      expectedSessionId: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
      includeUsage: true,
    });
    expect(unsafeGrok.usage).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      cachedInputTokens: null,
      outputTokens: 2,
      reasoningTokens: null,
      totalTokens: null,
      costUsd: 0.0042,
      provenance: {
        inputTokens: "provider_reported",
        cachedInputTokens: "unavailable",
        outputTokens: "provider_reported",
        reasoningTokens: "unavailable",
        totalTokens: "unavailable",
        costUsd: "provider_reported",
      },
    });
    const grokSession = {
      value: "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1",
      provenance: "command_pinned",
    } as const;
    expect(unsafeGrok.providerSessionRef).toEqual(grokSession);
    expectExactProviderTelemetry(telemetry.mapProviderTelemetryOutcome({
      provider: "grok",
      providerSessionRef: unsafeGrok.providerSessionRef as {
        value: string; provenance: "command_pinned";
      },
      outcome: "success",
      usageReport: unsafeGrok.usage,
    }), providerTelemetry("grok", grokSession, "succeeded", unavailableUsage("invalid_provider_usage")));
  });

  it("rejects malformed provider session identities", async () => {
    const { telemetry } = await load();
    expect(() => telemetry.mapProviderTelemetryOutcome({
      provider: "codex",
      providerSessionRef: { value: "", provenance: "provider_reported" },
      outcome: "success",
      usageReport: null,
    })).toThrow(/provider session|identity/i);
    expect(() => telemetry.mapProviderTelemetryOutcome({
      provider: "codex",
      providerSessionRef: { value: "invented", provenance: "provider_reported" },
      outcome: "pre_session_failure",
      usageReport: null,
    })).toThrow(/pre.session|provider session|identity/i);
  });

  it("keeps provider usage extraction out of every returned command argv", () => {
    const commands: Array<[Provider, CommandSpec]> = [
      ["codex", buildCodexCommand({
        binary: BINARIES.codex,
        cwd: RUNNER_PROJECT,
        prompt: "review",
        approvalScope: "workspace-read",
        effort: "high",
        timeoutMs: 90_000,
      })],
      ["grok", buildGrokCommand({
        binary: BINARIES.grok,
        cwd: RUNNER_PROJECT,
        prompt: "review",
        sessionId: SESSION_IDS.grok,
        approvalScope: "workspace-read",
        effort: "high",
        timeoutMs: 90_000,
      })],
      ["claude", buildClaudeCommand({
        binary: BINARIES.claude,
        cwd: RUNNER_PROJECT,
        prompt: "review",
        sessionId: SESSION_IDS.claude,
        approvalScope: "workspace-read",
        effort: "high",
        timeoutMs: 90_000,
      })],
    ];
    for (const [provider, command] of commands) {
      expectReadOnlyCommand(command, provider);
      expect(command).not.toHaveProperty("includeUsage");
    }
  });

  it.each([
    {
      provider: "codex",
      stdout: codexStdout(),
      text: "done",
      providerSessionRef: { value: "codex-thread-1", provenance: "provider_reported" },
      usage: exactUsage(),
    },
    {
      provider: "grok",
      stdout: grokStdout(),
      text: "done",
      providerSessionRef: { value: SESSION_IDS.grok, provenance: "command_pinned" },
      usage: exactUsage(),
    },
    {
      provider: "claude",
      stdout: claudeStdout(),
      text: JSON.stringify({ ok: true }),
      providerSessionRef: { value: SESSION_IDS.claude, provenance: "command_pinned" },
      usage: unavailableUsage(),
    },
  ] as const)("quarantines mapped $provider telemetry without changing saved routing or authority", async ({
    provider, stdout, text, providerSessionRef, usage,
  }) => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4_321,
      result: Promise.resolve({ exitCode: 0, stdout, stderr: "" } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const task = runnerTask(provider);
    const savedTask = structuredClone(task);
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();

    const result = await runnerWith(launch).run(task, onLaunch, onLaunchIntent);

    expectQuarantinedRunnerResult(result, {
      kind: "success",
      agent: provider,
      model: MODELS[provider],
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
      text,
    }, providerTelemetry(provider, providerSessionRef, "succeeded", usage));
    expect(task).toEqual(savedTask);
    expect(launch).toHaveBeenCalledTimes(1);
    expectReadOnlyCommand(launch.mock.calls[0]![0], provider);
    expectSavedRouting(onLaunchIntent, "launching", provider);
    expectSavedRouting(onLaunch, "started", provider, 4_321);
  });

  it.each([
    {
      provider: "codex",
      stdout: codexStdout({
        input_tokens: 1.5,
        output_tokens: 2,
        cost_usd: 0.0042,
      }),
      providerSessionRef: { value: "codex-thread-1", provenance: "provider_reported" },
    },
    {
      provider: "grok",
      stdout: grokStdout({
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        outputTokens: 2,
        costUSD: 0.0042,
      }),
      providerSessionRef: { value: SESSION_IDS.grok, provenance: "command_pinned" },
    },
  ] as const)("quarantines invalid usage from unsafe $provider output", async ({
    provider, stdout, providerSessionRef,
  }) => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4_325,
      result: Promise.resolve({ exitCode: 0, stdout, stderr: "" } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const task = runnerTask(provider);
    const savedTask = structuredClone(task);
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();

    const result = await runnerWith(launch).run(task, onLaunch, onLaunchIntent);

    expectQuarantinedRunnerResult(result, {
      kind: "success",
      agent: provider,
      model: MODELS[provider],
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
      text: "done",
    }, providerTelemetry(
      provider,
      providerSessionRef,
      "succeeded",
      unavailableUsage("invalid_provider_usage"),
    ));
    expect(task).toEqual(savedTask);
    expect(launch).toHaveBeenCalledTimes(1);
    expectReadOnlyCommand(launch.mock.calls[0]![0], provider);
    expectSavedRouting(onLaunchIntent, "launching", provider);
    expectSavedRouting(onLaunch, "started", provider, 4_325);
  });

  it("quarantines a started provider failure without fallback or authority drift", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4_322,
      result: Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "provider unavailable",
      } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const task = runnerTask("grok");
    const savedTask = structuredClone(task);
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();

    const result = await runnerWith(launch).run(task, onLaunch, onLaunchIntent);

    expectQuarantinedRunnerResult(result, {
      kind: "model_unavailable",
      agent: "grok",
      error: "agent exited 1",
      logs: ["provider unavailable"],
    }, providerTelemetry(
      "grok",
      { value: SESSION_IDS.grok, provenance: "command_pinned" },
      "provider_failure",
      unavailableUsage(),
    ));
    expect(task).toEqual(savedTask);
    expect(launch).toHaveBeenCalledTimes(1);
    expectReadOnlyCommand(launch.mock.calls[0]![0], "grok");
    expectSavedRouting(onLaunchIntent, "launching", "grok");
    expectSavedRouting(onLaunch, "started", "grok", 4_322);
  });

  it("classifies malformed terminal output without exposing its command-pinned session", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4_323,
      result: Promise.resolve({ exitCode: 0, stdout: "{", stderr: "" } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const task = runnerTask("claude");
    const savedTask = structuredClone(task);
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();

    const result = await runnerWith(launch).run(task, onLaunch, onLaunchIntent);

    expectQuarantinedRunnerResult(result, {
      kind: "task_failure",
      agent: "claude",
      error: "malformed Claude result JSON",
    }, providerTelemetry(
      "claude",
      { value: SESSION_IDS.claude, provenance: "command_pinned" },
      "malformed_terminal",
      unavailableUsage(),
    ));
    expect(task).toEqual(savedTask);
    expect(launch).toHaveBeenCalledTimes(1);
    expectReadOnlyCommand(launch.mock.calls[0]![0], "claude");
    expectSavedRouting(onLaunchIntent, "launching", "claude");
    expectSavedRouting(onLaunch, "started", "claude", 4_323);
  });

  it("quarantines timeout telemetry after terminating exactly one command-pinned process", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4_324,
      result: new Promise<ProcessResult>(() => undefined),
      terminate,
    }));
    const task = runnerTask("claude");
    const savedTask = structuredClone(task);
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();
    const pending = runnerWith(launch, 25).run(task, onLaunch, onLaunchIntent);

    await vi.advanceTimersByTimeAsync(2_025);
    const result = await pending;

    expectQuarantinedRunnerResult(result, {
      kind: "network_timeout",
      agent: "claude",
      error: "agent process group timeout",
    }, providerTelemetry(
      "claude",
      { value: SESSION_IDS.claude, provenance: "command_pinned" },
      "timeout",
      unavailableUsage(),
    ));
    expect(task).toEqual(savedTask);
    expect(launch).toHaveBeenCalledTimes(1);
    expectReadOnlyCommand(launch.mock.calls[0]![0], "claude");
    expectSavedRouting(onLaunchIntent, "launching", "claude");
    expectSavedRouting(onLaunch, "started", "claude", 4_324);
    expect(terminate.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("quarantines pre-session telemetry without inventing an identity when no process starts", async () => {
    const launch = vi.fn((_command: CommandSpec) => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    const task = runnerTask("codex");
    const savedTask = structuredClone(task);
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();
    const onProvenNoSpawn = vi.fn();

    const result = await runnerWith(launch).run(task, onLaunch, onLaunchIntent, onProvenNoSpawn);

    expectQuarantinedRunnerResult(result, {
      kind: "cli_missing",
      agent: "codex",
      error: "spawn ENOENT",
    }, providerTelemetry("codex", null, "pre_session_failure", unavailableUsage()));
    expect(task).toEqual(savedTask);
    expect(launch).toHaveBeenCalledTimes(1);
    expectReadOnlyCommand(launch.mock.calls[0]![0], "codex");
    expectSavedRouting(onLaunchIntent, "launching", "codex");
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onProvenNoSpawn).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-empty provider result quarantined through production callbacks and durable persistence", async () => {
    const state = createTelemetryFixture();
    roots.push(state.root);
    const runStore = new RunStore(state.databasePath);
    const queued = runStore.enqueue({
      idempotencyKey: "stg04-quarantined-provider-result",
      stage: "planning",
      priority: 1,
      approvalScope: "workspace-read",
      now: 1_000,
    });
    const domainBefore = telemetryDomainRows(state.databasePath);
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4_326,
      result: Promise.resolve({
        exitCode: 0,
        stdout: codexStdout(),
        stderr: "",
      } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const providerRunner = runnerWith(launch);
    let transientResult: Record<string, unknown> | undefined;
    const worker = new DurableWorker({
      store: runStore,
      workerId: "stg04-quarantine-worker",
      runner: async (_run, onLaunch, _commit, _persist, onLaunchIntent, onProvenNoSpawn) => {
        transientResult = await providerRunner.run(
          runnerTask("codex"),
          onLaunch,
          onLaunchIntent,
          onProvenNoSpawn,
        );
        return transientResult;
      },
    });

    const completed = await worker.runOnce(1_001);
    const expectedResult = {
      kind: "success",
      agent: "codex",
      model: MODELS.codex,
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
      text: "done",
    };
    if (!transientResult) throw new Error("runner did not return its transient provider result");
    expectQuarantinedRunnerResult(transientResult, expectedResult, providerTelemetry(
      "codex",
      { value: "codex-thread-1", provenance: "provider_reported" },
      "succeeded",
      exactUsage(),
    ));
    if (!completed || typeof completed.result !== "object" || completed.result === null) {
      throw new Error("durable worker did not persist a provider result");
    }
    expectQuarantinedRunnerResult(completed.result as Record<string, unknown>, expectedResult, null);
    expect(completed).toMatchObject({
      id: queued.id,
      status: "completed",
      launched: true,
      attemptCount: 1,
      result: expectedResult,
      launchInfo: {
        workerId: "stg04-quarantine-worker",
        phase: "started",
        pid: 4_326,
        agent: "codex",
        model: MODELS.codex,
        effort: "high",
        policyVersion: "routing-v5",
        sessionId: SESSION_IDS.codex,
      },
    });
    expect(runStore.pendingDomainEffects()).toEqual([]);
    expect(telemetryDomainRows(state.databasePath)).toEqual(domainBefore);
    worker.close();

    const reopenedRuns = new RunStore(state.databasePath);
    const reopened = reopenedRuns.get(queued.id);
    expect(reopened).toEqual(completed);
    if (!reopened || typeof reopened.result !== "object" || reopened.result === null) {
      throw new Error("reopened run lost its provider result");
    }
    expectQuarantinedRunnerResult(reopened.result as Record<string, unknown>, expectedResult, null);
    reopenedRuns.close();

    const telemetryStore = new FlowTelemetryStore(state.databasePath);
    expect(telemetryStore.getRunTelemetryLink(queued.id)).toEqual({
      status: "legacy_unlinked",
      usage: null,
      completeness: "unavailable",
    });
    expect(telemetryDomainRows(state.databasePath)).toEqual(domainBefore);
    telemetryStore.close();
  });
});
