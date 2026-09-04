import { afterEach, describe, expect, it, vi } from "vitest";
import { runCapabilityProbes } from "../src/probes/capability-probe.js";

const sessionId = "11c118c7-254f-4d94-a7c4-0562e41d9342";
const providers = {
  grok: {
    enabled: true,
    binaryPath: "/home/anton/.local/bin/grok",
    expectedVersion: "0.1.0",
    model: "grok-4.6" as const,
    effort: "high" as const,
    cwd: "/repo",
  },
  claude: {
    enabled: true,
    binaryPath: "/home/anton/.local/bin/claude",
    expectedVersion: "2.1.247 (Claude Code)",
    model: "glm-5.3" as const,
    effort: "max" as const,
    cwd: "/repo",
  },
  codex: {
    enabled: true,
    binaryPath: "/opt/agent-collab/bin/codex",
    expectedVersion: "0.147.0",
    model: "gpt-5.6-sol" as const,
    effort: "xhigh" as const,
    cwd: "/repo",
  },
};

const capabilityPayload = (effort: "high" | "xhigh" | "max") => JSON.stringify({
  protocolVersion: "agent-collab/v2",
  reasoningEffort: effort,
  supportsNonInteractive: true,
  supportsResume: true,
});

const probeInput = (agent: "grok" | "claude" | "codex", effort: "high" | "xhigh" | "max") =>
  agent === "claude"
    ? `Capability probe. Do not use tools. Return a review-verdict/v1 envelope with verdict PASS ` +
      `and exactly one info finding whose message is exactly this JSON: ${capabilityPayload(effort)}`
    : `Capability probe. Do not use tools. Return only valid JSON with exactly these keys: ` +
      `{"protocolVersion":"agent-collab/v2","reasoningEffort":"${effort}",` +
      `"visibleText":"{\\"protocolVersion\\":\\"agent-collab/v2\\",\\"reasoningEffort\\":\\"${effort}\\",` +
      `\\"supportsNonInteractive\\":true,\\"supportsResume\\":true}"}.`;

const success = (agent: "grok" | "claude" | "codex") => {
  if (agent === "grok") {
    return {
      exitCode: 0,
      version: "0.1.0",
      stdout: JSON.stringify({
        stopReason: "end_turn",
        sessionId,
        modelUsage: { "grok-4.6": { inputTokens: 12, outputTokens: 8 } },
        text: JSON.stringify({
          protocolVersion: "agent-collab/v2",
          reasoningEffort: "high",
          visibleText: capabilityPayload("high"),
        }),
        thought: "PRIVATE_PROBE_THOUGHT",
        tool_result: "PRIVATE_PROBE_TOOL_RESULT",
      }),
      stderr: "",
    };
  }
  if (agent === "claude") {
    const verdict = {
      schemaVersion: "review-verdict/v1",
      verdict: "PASS",
      findings: [{ risk_level: "info", message: capabilityPayload("max") }],
    };
    return {
      exitCode: 0,
      version: "2.1.247 (Claude Code)",
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: JSON.stringify(verdict),
        structured_output: verdict,
      }),
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    version: "0.147.0",
    stdout: [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "probe-codex-session", model: "gpt-5.6-sol" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "reasoning", encrypted_content: "PRIVATE_PROBE_REASONING" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              protocolVersion: "agent-collab/v2",
              reasoningEffort: "xhigh",
              visibleText: capabilityPayload("xhigh"),
            }),
          }],
        },
      }),
    ].join("\n") + "\n",
    stderr: "",
  };
};

const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const run = (runner: { execute: (request: { agent: "grok" | "claude" | "codex" }) => Promise<ReturnType<typeof success>> }) =>
  runCapabilityProbes({
    providers,
    timeoutMs: 3_000,
    runner,
    sessionIdFactory: () => sessionId,
  });

afterEach(() => vi.useRealTimers());

describe("BDD-9 executable bounded review-provider capability probes", () => {
  it("invokes all enabled providers once with exact v2 no-shell process contracts", async () => {
    const gates = {
      grok: pending<ReturnType<typeof success>>(),
      claude: pending<ReturnType<typeof success>>(),
      codex: pending<ReturnType<typeof success>>(),
    };
    const execute = vi.fn((request: { agent: "grok" | "claude" | "codex" }) => gates[request.agent].promise);

    const result = run({ execute });
    await expect.poll(() => execute.mock.calls.length).toBe(3);
    expect(execute.mock.calls.map(([request]) => request).sort((a, b) =>
      a.agent.localeCompare(b.agent))).toEqual([
      {
        agent: "claude",
        file: "/home/anton/.local/bin/claude",
        args: expect.arrayContaining([
          "-p", "--model", "glm-5.3", "--effort", "max",
          "--session-id", sessionId, "--no-session-persistence", "--safe-mode",
          "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep",
          "--output-format", "json",
        ]),
        cwd: "/repo",
        stdin: probeInput("claude", "max"),
        timeoutMs: 3_000,
        shell: false,
        killProcessGroup: true,
      },
      {
        agent: "codex",
        file: "/opt/agent-collab/bin/codex",
        args: [
          "exec", "--ignore-user-config", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="xhigh"',
          "-C", "/repo", "-s", "read-only", "--json", "-",
        ],
        cwd: "/repo",
        stdin: probeInput("codex", "xhigh"),
        timeoutMs: 3_000,
        shell: false,
        killProcessGroup: true,
      },
      {
        agent: "grok",
        file: "/home/anton/.local/bin/grok",
        args: [
          "--cwd", "/repo", "--model", "grok-4.6", "--reasoning-effort", "high",
          "--prompt-file", "/dev/stdin", "--verbatim", "--output-format", "json",
          "--session-id", sessionId, "--no-subagents", "--disable-web-search",
          "--deny", "mcp__*", "--sandbox", "strict", "--permission-mode", "dontAsk",
          "--tools", "read_file,grep,list_dir",
        ],
        cwd: "/repo",
        stdin: probeInput("grok", "high"),
        timeoutMs: 3_000,
        shell: false,
        killProcessGroup: true,
        promptFileArgIndex: 7,
      },
    ]);

    gates.claude.resolve(success("claude"));
    gates.codex.resolve(success("codex"));
    gates.grok.resolve(success("grok"));
    await expect(result).resolves.toEqual({
      results: {
        grok: { health: "healthy", ready: true, failures: [] },
        claude: { health: "healthy", ready: true, failures: [] },
        codex: { health: "healthy", ready: true, failures: [] },
      },
    });
  });

  it("never invokes a disabled provider", async () => {
    const execute = vi.fn(async (request: { agent: "grok" | "claude" | "codex" }) => success(request.agent));
    const result = await runCapabilityProbes({
      providers: { ...providers, grok: { ...providers.grok, enabled: false } },
      timeoutMs: 3_000,
      runner: { execute },
      sessionIdFactory: () => sessionId,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([request]) => request.agent).sort()).toEqual(["claude", "codex"]);
    expect(result.results.grok).toEqual({
      health: "disabled",
      ready: false,
      failures: ["provider_disabled"],
    });
  });

  it("bounds hung probes and classifies missing CLIs without retrying", async () => {
    vi.useFakeTimers();
    const never = new Promise<ReturnType<typeof success>>(() => undefined);
    const execute = vi.fn((request: { agent: "grok" | "claude" | "codex" }) => {
      if (request.agent === "grok") return never;
      if (request.agent === "claude") return Promise.resolve(success("claude"));
      return Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    });
    const result = run({ execute });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toEqual({
      results: {
        grok: { health: "unavailable", ready: false, failures: ["probe_timeout"] },
        claude: { health: "healthy", ready: true, failures: [] },
        codex: { health: "unavailable", ready: false, failures: ["cli_missing"] },
      },
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("propagates shutdown cancellation to every active probe runner", async () => {
    const controller = new AbortController();
    const execute = vi.fn((request: { signal?: AbortSignal }) =>
      new Promise<ReturnType<typeof success>>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      }));
    const result = runCapabilityProbes({
      providers,
      timeoutMs: 120_000,
      runner: { execute },
      sessionIdFactory: () => sessionId,
      signal: controller.signal,
    });
    await expect.poll(() => execute.mock.calls.length).toBe(3);

    controller.abort(new Error("worker shutdown"));

    await expect(result).rejects.toThrow("worker shutdown");
    expect(execute.mock.calls.every(([request]) => request.signal === controller.signal)).toBe(true);
  });

  it.each([
    ["grok malformed", "grok", "not-json"],
    [
      "grok effort downgrade",
      "grok",
      JSON.stringify({
        stopReason: "end_turn",
        modelUsage: { "grok-4.6": {} },
        text: JSON.stringify({
          protocolVersion: "agent-collab/v2",
          reasoningEffort: "medium",
          visibleText: capabilityPayload("high"),
        }),
      }),
    ],
    ["codex model drift", "codex", '{"type":"session_meta","payload":{"model":"gpt-5.7"}}\n'],
    ["codex malformed", "codex", '{"type":"session_meta"}\nnot-json\n'],
    ["claude malformed", "claude", "not-json"],
    ["claude session drift", "claude", JSON.stringify({
      ...JSON.parse(success("claude").stdout),
      session_id: "123e4567-e89b-42d3-a456-426614174999",
    })],
  ] as const)("fails closed for %s", async (_name, agent, stdout) => {
    const execute = vi.fn(async (request: { agent: "grok" | "claude" | "codex" }) =>
      request.agent === agent
        ? { ...success(request.agent), stdout }
        : success(request.agent));
    const result = await run({ execute });
    expect(result.results[agent]).toEqual({
      health: "unavailable",
      ready: false,
      failures: ["response_parse_failed"],
    });
  });

  it("rejects visible capability protocol drift even when the native model envelope is valid", async () => {
    const drift = JSON.stringify({
      protocolVersion: "agent-collab/v1",
      reasoningEffort: "xhigh",
      supportsNonInteractive: true,
      supportsResume: true,
    });
    const execute = vi.fn(async (request: { agent: "grok" | "claude" | "codex" }) => {
      if (request.agent !== "codex") return success(request.agent);
      return {
        ...success("codex"),
        stdout: [
          JSON.stringify({ type: "session_meta", payload: { model: "gpt-5.6-sol" } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: drift }],
            },
          }),
        ].join("\n") + "\n",
      };
    });
    const result = await run({ execute });
    expect(result.results.codex).toEqual({
      health: "unavailable",
      ready: false,
      failures: ["response_parse_failed"],
    });
  });
});
