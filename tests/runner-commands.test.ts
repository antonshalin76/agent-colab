import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentRunner,
  classifyRunnerFailure,
  type ProcessLauncher,
  type ProcessResult,
  type ProcessTask,
} from "../src/runners/agent-runner.js";
import { buildCodexCommand, normalizeCodexResult } from "../src/runners/codex.js";
import { buildProviderCommand, type CommandSpec } from "../src/runners/provider-command.js";
import { captureWorkspaceFingerprint } from "../src/runtime/workspace-fingerprint.js";
import { projectMapLearning } from "../src/flow/map-admin.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeCurrentExecutionSchema } from "../src/migration/coordinator.js";
import { CollaborationRuntime } from "../src/runtime/collaboration-runtime.js";
import { RunStore } from "../src/store/run-store.js";
import { createCollaborationRun } from "../src/workflow/workflow.js";
import { normalizeReviewProviderResult } from "../src/domain/review-verdict.js";
import { classifyProviderFailureDetail } from "../src/domain/outcomes.js";

const efforts = ["low", "medium", "high", "xhigh"] as const;

describe("provider retry evidence", () => {
  it("preserves the Claude five-hour usage-limit reset", () => {
    const now = new Date("2026-08-28T18:09:11+08:00").getTime();
    expect(classifyProviderFailureDetail(new Error(
      "API Error: Request rejected (429) [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-08-28 20:24:53]",
    ), "", now)).toEqual({
      kind: "rate_limit",
      retryAt: new Date("2026-08-28T20:24:53+08:00").getTime(),
    });
  });

  it.each(["unrecognized_model", "unsupported model", "model not found"])(
    "keeps deterministic model contract failure terminal: %s", (message) => {
      expect(classifyProviderFailureDetail(new Error(message))).toEqual({ kind: "task_failure" });
    },
  );
});

const codexStream = (text = "visible Codex answer", model = "gpt-5.6-sol") => [
  JSON.stringify({ type: "session_meta", payload: { id: "codex-session", model } }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "reasoning", encrypted_content: "PRIVATE_REASONING_SENTINEL" },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      name: "read_file",
      arguments: { path: "/private/TOOL_ARGUMENT_SENTINEL" },
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", output: "TOOL_RESULT_SENTINEL" },
  }),
].join("\n") + "\n";

afterEach(() => vi.useRealTimers());

describe("BDD-8 exact adaptive Codex command contract", () => {
  it.each(efforts)("uses the saved %s effort without widening read authority", (effort) => {
    const input = {
      binary: "/opt/codex",
      cwd: "/repo",
      prompt: "review",
      approvalScope: "workspace-read" as const,
      effort,
      timeoutMs: 90_000,
    };
    const expected: CommandSpec = {
      file: "/opt/codex",
      args: [
        "exec",
        "--ignore-user-config",
        "-m",
        "gpt-5.6-sol",
        "-c",
        `model_reasoning_effort="${effort}"`,
        "-C",
        "/repo",
        "-s",
        "read-only",
        "--json",
        "-",
      ],
      cwd: "/repo",
      stdin: "review",
      shell: false,
      timeoutMs: 90_000,
      killProcessGroup: true,
    };
    expect(buildCodexCommand(input)).toEqual(expected);
    expect(buildProviderCommand({ agent: "codex", command: input })).toEqual(expected);
  });

  it.each([
    ["workspace-write", "workspace-write"],
    ["external", "danger-full-access"],
  ] as const)("maps approved %s to only its explicit sandbox", (approvalScope, sandbox) => {
    const command = buildCodexCommand({
      binary: "/opt/codex",
      cwd: "/repo",
      prompt: "implement",
      approvalScope,
      authorizationConsumerKey: `authority:${approvalScope}`,
      effort: "high",
      timeoutMs: 90_000,
    });
    expect(command.args).toEqual([
      "exec", "--ignore-user-config", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"',
      "-C", "/repo", "-s", sandbox, "--json", "-",
    ]);
    expect(command.args.join(" ")).not.toMatch(/bypass|dangerously/);
  });

  it("requires upstream approval evidence before any mutable sandbox", () => {
    for (const approvalScope of ["workspace-write", "external"] as const) {
      expect(() => buildCodexCommand({
        binary: "/opt/codex",
        cwd: "/repo",
        prompt: "implement",
        approvalScope,
        effort: "high",
        timeoutMs: 90_000,
      })).toThrow(/authority|receipt/i);
    }
  });

  it("accepts only the exact returned model and strips non-visible records", () => {
    const normalized = normalizeCodexResult(codexStream());
    expect(normalized).toEqual({ text: "visible Codex answer", model: "gpt-5.6-sol" });
    expect(JSON.stringify(normalized)).not.toMatch(/PRIVATE_REASONING|TOOL_ARGUMENT|TOOL_RESULT/);
    expect(() => normalizeCodexResult(codexStream("answer", "gpt-5.7"))).toThrow(/model identity/i);
    expect(() => normalizeCodexResult('{"type":"session_meta"}\nnot-json\n')).toThrow(/malformed|parse/i);
  });
});

describe("process-only AgentRunner", () => {
  const runnerProject = process.cwd();
  const codexProjection = projectMapLearning(runnerProject, "codex").projection;
  const codexLearningContext = `Promoted MAP learning projection for codex (${codexProjection.digest}):\n${Buffer.from(
    codexProjection.bytes,
  ).toString("utf8").trimEnd()}`;
  const codexLearningBinding = {
    schemaVersion: "map-learning-launch-binding/v1",
    consumer: "codex",
    projectionBase64: Buffer.from(codexProjection.bytes).toString("base64"),
    digest: codexProjection.digest,
  } as const;
  const claudeProjection = projectMapLearning(runnerProject, "claude").projection;
  const claudeLearningContext = `Promoted MAP learning projection for claude (${claudeProjection.digest}):\n${Buffer.from(
    claudeProjection.bytes,
  ).toString("utf8").trimEnd()}`;
  const claudeLearningBinding = {
    schemaVersion: "map-learning-launch-binding/v1",
    consumer: "claude",
    projectionBase64: Buffer.from(claudeProjection.bytes).toString("base64"),
    digest: claudeProjection.digest,
  } as const;
  const grokProjection = projectMapLearning(runnerProject, "grok").projection;
  const grokLearningContext = `Promoted MAP learning projection for grok (${grokProjection.digest}):\n${Buffer.from(
    grokProjection.bytes,
  ).toString("utf8").trimEnd()}`;
  const grokLearningBinding = {
    schemaVersion: "map-learning-launch-binding/v1",
    consumer: "grok",
    projectionBase64: Buffer.from(grokProjection.bytes).toString("base64"),
    digest: grokProjection.digest,
  } as const;
  const task = (overrides: Record<string, unknown> = {}) => {
    const decision = {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
    } as const;
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    return {
      id: "run-1",
      stage: "review:auditor",
      artifactHash: "a".repeat(64),
      idempotencyKey: "workflow:dispatch:0",
      approvalScope: "workspace-read",
      payload: {
        project: runnerProject,
        prompt: `${codexLearningContext}\n\nreview`,
        approvalScope: "workspace-read",
        requester: "codex",
        reviewAttemptId: "review:attempt:0:codex:routing-v5",
        reviewAttemptOrdinal: 0,
        reviewDispatchId: "workflow:dispatch:0",
        sourceFingerprint: captureWorkspaceFingerprint(runnerProject).fingerprint,
        mapLearning: codexLearningBinding,
        decision,
        sessionId,
        reviewDispatchIdentity: {
          ...decision,
          sessionId,
          attemptId: "review:attempt:0:codex:routing-v5",
          attemptOrdinal: 0,
          degraded: false,
        },
        ...overrides,
      },
    };
  };

  it("launches one process from the immutable saved decision and returns its evidence", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4321,
      result: Promise.resolve({ exitCode: 0, stdout: codexStream(), stderr: "" }),
      terminate: vi.fn(),
    }));
    const launcher: ProcessLauncher = { launch };
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher,
    });
    const onLaunch = vi.fn();

    await expect(runner.run(task(), onLaunch)).resolves.toEqual({
      kind: "success",
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
      text: "visible Codex answer",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toMatchObject({
      file: "/opt/codex",
      cwd: runnerProject,
      stdin: `${codexLearningContext}\n\nreview`,
      killProcessGroup: true,
    });
    expect(onLaunch.mock.calls).toEqual([
      [{ phase: "started", pid: 4321, agent: "codex", model: "gpt-5.6-sol",
        effort: "high", policyVersion: "routing-v5", sessionId: "123e4567-e89b-42d3-a456-426614174000" }],
    ]);
    expect(runner).not.toHaveProperty("close");
    expect(runner).not.toHaveProperty("releaseHandoffLease");
  });

  it("drives a valid Claude review task through the runner and returns its structured report to Codex", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const attemptId = "123e4567-e89b-42d3-a456-426614174001";
    const verdict = {
      schemaVersion: "review-verdict/v1",
      verdict: "CHANGES_REQUESTED",
      findings: [{ risk_level: "error", message: "architecture boundary leak" }],
    };
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: JSON.stringify(verdict),
      structured_output: verdict,
    });
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4322,
      result: Promise.resolve({ exitCode: 0, stdout, stderr: "" }),
      terminate: vi.fn(),
    }));
    const decision = {
      agent: "claude",
      model: "glm-5.3",
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
    } as const;
    const runner = new AgentRunner({
      binaries: { grok: "/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/bin/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const candidate = task({
      prompt: `${claudeLearningContext}\n\nreview`,
      mapLearning: claudeLearningBinding,
      decision,
      sessionId,
      reviewAttemptId: attemptId,
      reviewDispatchIdentity: {
        ...decision,
        sessionId,
        attemptId,
        attemptOrdinal: 0,
        degraded: false,
      },
    });

    await expect(runner.run(candidate)).resolves.toEqual({
      kind: "success",
      agent: "claude",
      model: "glm-5.3",
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
      text: JSON.stringify(verdict),
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toMatchObject({
      file: "/home/anton/.local/bin/claude",
      cwd: runnerProject,
      stdin: `${claudeLearningContext}\n\nreview`,
      killProcessGroup: true,
    });
  });

  it("accepts Grok plain visible text from the command-pinned terminal envelope", async () => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const attemptId = "123e4567-e89b-42d3-a456-426614174001";
    const verdict = {
      schemaVersion: "review-verdict/v1",
      verdict: "PASS",
      findings: [],
    } as const;
    const decision = {
      agent: "grok",
      model: "grok-4.6",
      effort: "high",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:code_audit:high"],
    } as const;
    for (const terminalText of [
      `I'll inspect the review target.\n${JSON.stringify(verdict)}`,
      `I'll inspect the review target.\n${JSON.stringify({
        protocolVersion: "agent-collab/v2",
        reasoningEffort: "high",
        visibleText: JSON.stringify(verdict),
      })}`,
    ]) {
      const stdout = JSON.stringify({
        stopReason: "end_turn",
        sessionId,
        modelUsage: { "grok-4.6": { inputTokens: 1, outputTokens: 1 } },
        text: terminalText,
      });
      const runner = new AgentRunner({
        binaries: { grok: "/home/anton/.local/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
        timeoutMs: 90_000,
        launcher: { launch: () => ({
          pid: 4323,
          result: Promise.resolve({ exitCode: 0, stdout, stderr: "" }),
          terminate: vi.fn(),
        }) },
      });
      const candidate = task({
        prompt: `${grokLearningContext}\n\nreview`, mapLearning: grokLearningBinding,
        decision, sessionId, reviewAttemptId: attemptId,
        reviewDispatchIdentity: {
          ...decision, sessionId, attemptId, attemptOrdinal: 0, degraded: false,
        },
      });

      const result = await runner.run(candidate);
      expect(normalizeReviewProviderResult(result)).toMatchObject({
        kind: "success", agent: "grok", reviewVerdict: verdict,
      });
    }
  });

  it("rejects a review attempt id detached from its immutable dispatch identity", async () => {
    const launch = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    await expect(runner.run(task({ reviewAttemptId: "forged:attempt" }))).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/review attempt|dispatch identity/i),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a missing, malformed, stale, misrouted, or prompt-detached MAP learning snapshot before launch evidence", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4321,
      result: Promise.resolve({ exitCode: 0, stdout: codexStream(), stderr: "" }),
      terminate: vi.fn(),
    }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const onLaunch = vi.fn();
    const missing = structuredClone(task()) as ProcessTask;
    delete missing.payload!.mapLearning;
    const malformed = task({ mapLearning: {
      ...codexLearningBinding,
      projectionBase64: "not-base64",
    } });
    const stale = task({ mapLearning: {
      ...codexLearningBinding,
      digest: "0".repeat(64),
    } });
    const misrouted = task({ mapLearning: {
      ...codexLearningBinding,
      consumer: "grok",
    } });
    const promptDetached = task({ prompt: "review without the promoted MAP learning projection" });
    const promptDuplicated = task({
      prompt: `${codexLearningContext}\n\n${codexLearningContext}\n\nreview`,
    });

    for (const candidate of [
      missing,
      malformed,
      stale,
      misrouted,
      promptDetached,
      promptDuplicated,
    ]) {
      await expect(runner.run(candidate, onLaunch)).resolves.toMatchObject({
        kind: "invalid_request",
        error: expect.stringMatching(/MAP learning|projection|stale/i),
      });
    }
    expect(launch).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("rechecks the MAP learning binding at the final pre-spawn checkpoint", async () => {
    const candidate = task();
    const launch = vi.fn();
    const onLaunch = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
      preLaunchMapLearningCheckpoint: (binding: { digest: string }) => {
        binding.digest = "0".repeat(64);
      },
    } as ConstructorParameters<typeof AgentRunner>[0] & {
      preLaunchMapLearningCheckpoint: (binding: { digest: string }) => void;
    });

    await expect(runner.run(candidate, onLaunch)).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/MAP learning|stale|projection|admission payload changed/i),
    });
    expect(launch).not.toHaveBeenCalled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("rechecks the target source fingerprint at the final pre-spawn checkpoint", async () => {
    const project = mkdtempSync(join(tmpdir(), "agent-collab-final-source-"));
    try {
      const candidate = task({
        project,
        sourceFingerprint: captureWorkspaceFingerprint(project).fingerprint,
      });
      const launch = vi.fn(() => ({
        pid: 4321,
        result: Promise.resolve({ exitCode: 0, stdout: codexStream(), stderr: "" }),
        terminate: vi.fn(),
      }));
      const onLaunch = vi.fn();
      const runner = new AgentRunner({
        binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
        timeoutMs: 90_000,
        launcher: { launch },
        preLaunchMapLearningCheckpoint: () => {
          writeFileSync(join(project, "source.ts"), "changed before spawn\n");
        },
      } as ConstructorParameters<typeof AgentRunner>[0] & {
        preLaunchMapLearningCheckpoint: () => void;
      });

      await expect(runner.run(candidate, onLaunch)).resolves.toMatchObject({
        kind: "invalid_request",
        error: expect.stringMatching(/source fingerprint|stale/i),
      });
      expect(launch).not.toHaveBeenCalled();
      expect(onLaunch).not.toHaveBeenCalled();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("rechecks admission after launch intent and clears intent when no process starts", async () => {
    const project = mkdtempSync(join(tmpdir(), "agent-collab-intent-source-"));
    try {
      const candidate = task({ project,
        sourceFingerprint: captureWorkspaceFingerprint(project).fingerprint });
      const launch = vi.fn(); const onLaunch = vi.fn(); const onProvenNoSpawn = vi.fn();
      const runner = new AgentRunner({ binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
        timeoutMs: 90_000, launcher: { launch } });
      await expect(runner.run(candidate, onLaunch, () => {
        writeFileSync(join(project, "drift-after-intent.txt"), "changed\n");
      }, onProvenNoSpawn)).resolves.toMatchObject({
        kind: "invalid_request", error: expect.stringMatching(/source fingerprint|stale/i),
      });
      expect(launch).not.toHaveBeenCalled(); expect(onLaunch).not.toHaveBeenCalled();
      expect(onProvenNoSpawn).toHaveBeenCalledTimes(1);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it.each([undefined, "legacy-stage"])("rejects missing or unknown stage %s before launch", async (stage) => {
    const launch = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const invalid = structuredClone(task()) as unknown as ProcessTask;
    if (stage === undefined) delete invalid.stage;
    else invalid.stage = stage;
    await expect(runner.run(invalid)).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/canonical|stage/i),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    ["grok", "grok-4.6"],
    ["claude", "glm-5.3"],
  ] as const)("rejects %s from a non-review workflow before any process can start", async (agent, model) => {
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const launch = vi.fn(() => {
      throw new Error("POISON: a real provider process must never start");
    });
    const runner = new AgentRunner({
      binaries: {
        grok: "/home/anton/.local/bin/grok",
        claude: "/home/anton/.local/bin/claude",
        codex: "/opt/codex",
      },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const identity = {
      agent,
      model,
      effort: "medium",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:ui_ux:medium"],
      sessionId,
      attemptId: `ui:attempt:0:${agent}:routing-v5`,
      attemptOrdinal: 0,
      degraded: false,
    } as const;

    await expect(runner.run({
      id: `${agent}-workflow`,
      stage: "ui_ux",
      idempotencyKey: "workflow:dispatch:0",
      approvalScope: "workspace-write",
      payload: {
        project: "/repo",
        prompt: "implement UI",
        approvalScope: "workspace-write",
        requester: "codex",
        workflowId: "workflow",
        workflowStageId: "ui_ux",
        workflowDispatchId: "workflow:dispatch:0",
        sourceFingerprint: "f".repeat(64),
        decision: identity,
        workflowDispatchIdentity: identity,
        sessionId,
      },
    })).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/review-only|isolated review|Codex.*workflow/i),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects Grok workflow mutation before launch", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4322,
      result: Promise.resolve({ exitCode: 0, stderr: "", stdout: JSON.stringify({
        stopReason: "end_turn", sessionId: "123e4567-e89b-42d3-a456-426614174000",
        modelUsage: { "grok-4.6": { inputTokens: 1, outputTokens: 1 } },
        text: JSON.stringify({ protocolVersion: "agent-collab/v2", reasoningEffort: "high", visibleText: "done" }),
      }) }),
      terminate: vi.fn(),
    }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const result = await runner.run({
      id: "grok-write", stage: "ui_ux", approvalScope: "workspace-write",
      payload: { project: "/repo", prompt: "implement UI", approvalScope: "workspace-write",
        approvalReference: "approval:grok-write", sessionId: "123e4567-e89b-42d3-a456-426614174000",
        decision: { agent: "grok", model: "grok-4.6", effort: "high", policyVersion: "routing-v5",
          reasons: ["stage_baseline:ui_ux:medium", "broad_change_set"] },
        workflowDispatchIdentity: { agent: "grok", model: "grok-4.6", effort: "high",
          policyVersion: "routing-v5", reasons: ["stage_baseline:ui_ux:medium", "broad_change_set"],
          sessionId: "123e4567-e89b-42d3-a456-426614174000", attemptId: "ui:attempt:0:grok:routing-v5",
          attemptOrdinal: 0, degraded: false } },
    });
    expect(result).toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/isolated review lanes/i),
    });
    expect(launch).not.toHaveBeenCalled();

    const forged = await runner.run({
      id: "grok-forged", stage: "ui_ux", approvalScope: "workspace-write",
      payload: { project: "/repo", prompt: "implement UI", approvalScope: "workspace-write",
        approvalReference: "approval:grok-write", sessionId: "123e4567-e89b-42d3-a456-426614174001",
        toolAllowlist: ["run_terminal_cmd"],
        decision: { agent: "grok", model: "grok-4.6", effort: "high", policyVersion: "routing-v5",
          reasons: ["stage_baseline:ui_ux:high"] } },
    });
    expect(forged).toMatchObject({ kind: "invalid_request" });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    [{ model: "gpt-5.7" }, /model mismatch/i],
    [{ effort: "max" }, /unsupported effort/i],
    [{ policyVersion: "routing-v1" }, /policy version/i],
    [{ reasons: [] }, /reasons/i],
    [{ reasons: ["caller_supplied_reason"] }, /reasons/i],
  ] as const)("rejects malformed saved decisions before launch", async (decisionOverride, error) => {
    const launch = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const baseDecision = (task().payload.decision as Record<string, unknown>);
    const result = await runner.run(task({ decision: { ...baseDecision, ...decisionOverride } }));
    expect(result).toMatchObject({ kind: "invalid_request", error });
    expect(launch).not.toHaveBeenCalled();
  });

  it("terminates a started process if durable started evidence cannot be persisted", async () => {
    const terminate = vi.fn();
    const launch = vi.fn(() => ({
      pid: 4321,
      result: Promise.resolve({ exitCode: 0, stdout: codexStream(), stderr: "" }),
      terminate,
    }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    await expect(runner.run(task(), () => {
      throw new Error("launch started fence rejected");
    })).resolves.toMatchObject({ kind: "task_failure", agent: "codex" });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(terminate.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("does not emit started evidence when the launcher throws synchronously", async () => {
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();
    const onProvenNoSpawn = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch: () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); } },
    });
    await expect(runner.run(task(), onLaunch, onLaunchIntent, onProvenNoSpawn)).resolves.toMatchObject({
      kind: "cli_missing",
      agent: "codex",
    });
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onLaunchIntent).toHaveBeenCalledWith(expect.objectContaining({ phase: "launching", agent: "codex" }));
    expect(onProvenNoSpawn).toHaveBeenCalledTimes(1);
  });

  it("does not emit started evidence when an async spawn has no process id", async () => {
    const onLaunch = vi.fn();
    const onLaunchIntent = vi.fn();
    const onProvenNoSpawn = vi.fn();
    const terminate = vi.fn();
    const result = Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/missing/codex" },
      timeoutMs: 90_000,
      launcher: {
        launch: () => ({ pid: undefined, result, terminate }) as unknown as ReturnType<ProcessLauncher["launch"]>,
      },
    });
    await expect(runner.run(task(), onLaunch, onLaunchIntent, onProvenNoSpawn)).resolves.toMatchObject({
      kind: "cli_missing",
      agent: "codex",
    });
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onLaunchIntent).toHaveBeenCalledTimes(1);
    expect(onProvenNoSpawn).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith("SIGTERM");
  });

  it("never performs fallback or a second launch after a provider failure", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      pid: 4323,
      result: Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "429 rate limit Authorization: Bearer FAKE_RUNNER_SECRET",
      } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const result = await runner.run(task());
    expect(result).toMatchObject({ kind: "rate_limit", agent: "codex" });
    expect(JSON.stringify(result)).not.toContain("FAKE_RUNNER_SECRET");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects a copied durable payload under a fresh queue identity before launch", async () => {
    const launch = vi.fn();
    const runner = new AgentRunner({ binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
      timeoutMs: 90_000, launcher: { launch } });
    const copied = structuredClone(task());
    copied.idempotencyKey = "forged:dispatch:1";
    await expect(runner.run(copied)).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/queue identity|dispatch id/i),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects source drift after durable review admission and before launch", async () => {
    const project = mkdtempSync(join(tmpdir(), "agent-collab-runner-source-"));
    try {
      const sourceFingerprint = captureWorkspaceFingerprint(project).fingerprint;
      writeFileSync(join(project, "drift.txt"), "changed after admission\n");
      const launch = vi.fn();
      const runner = new AgentRunner({ binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
        timeoutMs: 90_000, launcher: { launch } });
      await expect(runner.run(task({ project, sourceFingerprint }))).resolves.toMatchObject({
        kind: "invalid_request",
        error: expect.stringMatching(/source fingerprint|stale/i),
      });
      expect(launch).not.toHaveBeenCalled();
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it("rejects a workflow stage that bypasses the durable execution snapshot", async () => {
    const planning = structuredClone(task()) as ProcessTask;
    planning.stage = "planning";
    planning.idempotencyKey = "workflow:dispatch:0";
    const payload = planning.payload!;
    const decision = {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
      policyVersion: "routing-v5",
      reasons: ["stage_baseline:planning:medium"],
    };
    payload.decision = decision;
    payload.workflowStageId = "planning";
    payload.workflowId = "workflow";
    payload.workflowDispatchId = "workflow:dispatch:0";
    delete payload.reviewDispatchIdentity;
    delete payload.reviewDispatchId;
    delete payload.reviewAttemptId;
    delete payload.reviewAttemptOrdinal;
    payload.workflowDispatchIdentity = {
      ...decision,
      sessionId: payload.sessionId,
      attemptId: "planning:attempt:0:codex:routing-v5",
      attemptOrdinal: 0,
      degraded: false,
    };
    const launch = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    await expect(runner.run(planning)).resolves.toMatchObject({
      kind: "invalid_request",
      error: expect.stringMatching(/trusted durable execution identity|executionSnapshot/i),
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a coherently tampered queued assignment before launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-runner-assignment-"));
    const project = join(root, "project");
    const database = join(root, "state.db");
    mkdirSync(project);
    try {
      initializeCurrentExecutionSchema(database);
      const workspace = captureWorkspaceFingerprint(project);
      const run = createCollaborationRun({ taskId: "tampered-assignment", origin: "codex",
        health: { grok: "healthy", codex: "healthy" }, stages: [{
          id: "coordination", kind: "coordination", role: "coordinator",
          artifactRef: `artifact:${"a".repeat(64)}`, artifactHash: "a".repeat(64),
          artifactBytes: 1, changedFiles: workspace.changedFiles.length,
          approvalScope: "workspace-read", idempotencyKey: "coordination", project,
          prompt: `${codexLearningContext}\n\ncoordinate`, requester: "codex",
          sourceFingerprint: workspace.fingerprint, mapLearning: codexLearningBinding,
        }] });
      const runtime = new CollaborationRuntime(database);
      runtime.createAndStart("workflow", run, [], 1);
      const runs = new RunStore(database);
      runtime.drainDispatchOutbox(runs, 1);
      const queued = runs.getByIdempotencyKey("workflow:dispatch:0")!;
      const forged = structuredClone(queued) as ProcessTask;
      const identity = forged.payload!.workflowDispatchIdentity as Record<string, unknown>;
      const forgedSession = "123e4567-e89b-42d3-a456-426614174999";
      forged.payload!.sessionId = forgedSession;
      forged.payload!.workflowDispatchIdentity = { ...identity, sessionId: forgedSession };
      const launch = vi.fn(); const onLaunch = vi.fn();
      const runner = new AgentRunner({ binaries: { grok: "/bin/grok", claude: "/bin/claude", codex: "/bin/codex" },
        timeoutMs: 90_000, authorizationDatabasePath: database, launcher: { launch } });
      await expect(runner.run(forged, onLaunch)).resolves.toMatchObject({
        kind: "invalid_request", error: expect.stringMatching(/assignment|durable dispatch/i),
      });
      expect(launch).not.toHaveBeenCalled(); expect(onLaunch).not.toHaveBeenCalled();
      runs.close(); runtime.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("terminates the one launched process group when the saved timeout expires", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const never = new Promise<ProcessResult>(() => undefined);
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", claude: "/home/anton/.local/bin/claude", codex: "/opt/codex" },
      timeoutMs: 250,
      launcher: { launch: () => ({ pid: 4321, result: never, terminate }) },
    });
    const result = runner.run(task());
    await vi.advanceTimersByTimeAsync(2_250);
    await expect(result).resolves.toMatchObject({ kind: "network_timeout", agent: "codex" });
    expect(terminate.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("keeps transport failures retryable but makes deterministic contract drift terminal", () => {
    expect(classifyRunnerFailure(new Error("model identity mismatch: gpt-5.7"))).toBe("task_failure");
    expect(classifyRunnerFailure(new Error("Grok protocol mismatch"))).toBe("task_failure");
    expect(classifyRunnerFailure(new Error("Grok reasoning effort mismatch"))).toBe("task_failure");
    expect(classifyRunnerFailure(new Error("malformed Codex JSONL parse"))).toBe("model_unavailable");
  });

  it("does not retry malformed visible model output as provider unavailability", () => {
    expect(classifyRunnerFailure(new Error("malformed Grok visible result parse"))).toBe("task_failure");
  });
});
