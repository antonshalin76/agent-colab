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

const efforts = ["low", "medium", "high", "xhigh"] as const;

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
      approvalReference: `approval:${approvalScope}`,
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
      })).toThrow(/approval/i);
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
  const task = (overrides: Record<string, unknown> = {}) => {
    const decision = {
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      policyVersion: "routing-v3",
      reasons: ["stage_baseline:code_review:high"],
    } as const;
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    return {
      id: "run-1",
      stage: "code_review",
      approvalScope: "workspace-read",
      payload: {
        project: "/repo",
        prompt: "review",
        approvalScope: "workspace-read",
        decision,
        sessionId,
        workflowDispatchIdentity: {
          ...decision,
          sessionId,
          attemptId: "review:attempt:0:codex:routing-v3",
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
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher,
    });
    const onLaunch = vi.fn();

    await expect(runner.run(task(), onLaunch)).resolves.toEqual({
      kind: "success",
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      policyVersion: "routing-v3",
      reasons: ["stage_baseline:code_review:high"],
      text: "visible Codex answer",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toMatchObject({
      file: "/opt/codex",
      cwd: "/repo",
      stdin: "review",
      killProcessGroup: true,
    });
    expect(onLaunch.mock.calls).toEqual([
      [{ phase: "intent", pid: null, agent: "codex", model: "gpt-5.6-sol",
        effort: "high", policyVersion: "routing-v3", sessionId: "123e4567-e89b-42d3-a456-426614174000" }],
      [{ phase: "started", pid: 4321, agent: "codex", model: "gpt-5.6-sol",
        effort: "high", policyVersion: "routing-v3", sessionId: "123e4567-e89b-42d3-a456-426614174000" }],
    ]);
    expect(runner).not.toHaveProperty("close");
    expect(runner).not.toHaveProperty("releaseHandoffLease");
  });

  it.each([undefined, "legacy-stage"])("rejects missing or unknown stage %s before launch", async (stage) => {
    const launch = vi.fn();
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
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

  it("derives Grok workspace-write tools from the canonical stage, never from caller payload", async () => {
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
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const result = await runner.run({
      id: "grok-write", stage: "ui_ux", approvalScope: "workspace-write",
      payload: { project: "/repo", prompt: "implement UI", approvalScope: "workspace-write",
        approvalReference: "approval:grok-write", sessionId: "123e4567-e89b-42d3-a456-426614174000",
        decision: { agent: "grok", model: "grok-4.6", effort: "high", policyVersion: "routing-v3",
          reasons: ["stage_baseline:ui_ux:medium", "broad_change_set"] },
        workflowDispatchIdentity: { agent: "grok", model: "grok-4.6", effort: "high",
          policyVersion: "routing-v3", reasons: ["stage_baseline:ui_ux:medium", "broad_change_set"],
          sessionId: "123e4567-e89b-42d3-a456-426614174000", attemptId: "ui:attempt:0:grok:routing-v3",
          attemptOrdinal: 0, degraded: false } },
    });
    expect(result).toMatchObject({ kind: "success", agent: "grok" });
    const command = launch.mock.calls[0]![0];
    expect(command.args.slice(command.args.indexOf("--tools") + 1, command.args.indexOf("--tools") + 2))
      .toEqual(["read_file,grep,list_dir,run_terminal_cmd,search_replace"]);

    const forged = await runner.run({
      id: "grok-forged", stage: "ui_ux", approvalScope: "workspace-write",
      payload: { project: "/repo", prompt: "implement UI", approvalScope: "workspace-write",
        approvalReference: "approval:grok-write", sessionId: "123e4567-e89b-42d3-a456-426614174001",
        toolAllowlist: ["run_terminal_cmd"],
        decision: { agent: "grok", model: "grok-4.6", effort: "high", policyVersion: "routing-v3",
          reasons: ["stage_baseline:ui_ux:high"] } },
    });
    expect(forged).toMatchObject({ kind: "invalid_request" });
    expect(launch).toHaveBeenCalledTimes(1);
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
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const baseDecision = (task().payload.decision as Record<string, unknown>);
    const result = await runner.run(task({ decision: { ...baseDecision, ...decisionOverride } }));
    expect(result).toMatchObject({ kind: "invalid_request", error });
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not launch if durable launch-intent persistence rejects the attempt", async () => {
    const terminate = vi.fn();
    const launch = vi.fn(() => ({
      pid: 4321,
      result: Promise.resolve({ exitCode: 0, stdout: codexStream(), stderr: "" }),
      terminate,
    }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    await expect(runner.run(task(), () => {
      throw new Error("launch intent fence rejected");
    })).resolves.toMatchObject({ kind: "task_failure", agent: "codex" });
    expect(launch).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("never performs fallback or a second launch after a provider failure", async () => {
    const launch = vi.fn((_command: CommandSpec) => ({
      result: Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "429 rate limit Authorization: Bearer FAKE_RUNNER_SECRET",
      } satisfies ProcessResult),
      terminate: vi.fn(),
    }));
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
      timeoutMs: 90_000,
      launcher: { launch },
    });
    const result = await runner.run(task());
    expect(result).toMatchObject({ kind: "rate_limit", agent: "codex" });
    expect(JSON.stringify(result)).not.toContain("FAKE_RUNNER_SECRET");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("terminates the one launched process group when the saved timeout expires", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const never = new Promise<ProcessResult>(() => undefined);
    const runner = new AgentRunner({
      binaries: { grok: "/home/anton/.local/bin/grok", codex: "/opt/codex" },
      timeoutMs: 250,
      launcher: { launch: () => ({ pid: 4321, result: never, terminate }) },
    });
    const result = runner.run(task());
    await vi.advanceTimersByTimeAsync(2_250);
    await expect(result).resolves.toMatchObject({ kind: "network_timeout", agent: "codex" });
    expect(terminate.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("classifies exact-model and protocol drift as provider-unavailable outcomes", () => {
    expect(classifyRunnerFailure(new Error("model identity mismatch: gpt-5.7"))).toBe("model_unavailable");
    expect(classifyRunnerFailure(new Error("Grok protocol mismatch"))).toBe("model_unavailable");
    expect(classifyRunnerFailure(new Error("malformed Codex JSONL parse"))).toBe("model_unavailable");
  });
});
