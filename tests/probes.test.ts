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
  codex: {
    enabled: true,
    binaryPath: "/opt/agent-collab/bin/codex",
    expectedVersion: "0.147.0",
    model: "gpt-5.6-sol" as const,
    effort: "xhigh" as const,
    cwd: "/repo",
  },
};

const probeInput = (effort: "high" | "xhigh") =>
  `Capability probe. Do not use tools. Return only valid JSON with exactly these keys: ` +
  `{"protocolVersion":"agent-collab/v2","reasoningEffort":"${effort}",` +
  `"visibleText":"{\\"protocolVersion\\":\\"agent-collab/v2\\",\\"reasoningEffort\\":\\"${effort}\\",` +
  `\\"supportsNonInteractive\\":true,\\"supportsResume\\":true}"}.`;

const capabilityPayload = (effort: "high" | "xhigh") => JSON.stringify({
  protocolVersion: "agent-collab/v2",
  reasoningEffort: effort,
  supportsNonInteractive: true,
  supportsResume: true,
});

const success = (agent: "grok" | "codex") => {
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
          content: [{ type: "output_text", text: capabilityPayload("xhigh") }],
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

const run = (runner: { execute: (request: { agent: "grok" | "codex" }) => Promise<ReturnType<typeof success>> }) =>
  runCapabilityProbes({
    providers,
    timeoutMs: 3_000,
    runner,
    sessionIdFactory: () => sessionId,
  });

afterEach(() => vi.useRealTimers());

describe("BDD-9 executable bounded Grok/Codex capability probes", () => {
  it("invokes both enabled providers once with exact v2 no-shell process contracts", async () => {
    const gates = {
      grok: pending<ReturnType<typeof success>>(),
      codex: pending<ReturnType<typeof success>>(),
    };
    const execute = vi.fn((request: { agent: "grok" | "codex" }) => gates[request.agent].promise);

    const result = run({ execute });
    await expect.poll(() => execute.mock.calls.length).toBe(2);
    expect(execute.mock.calls.map(([request]) => request).sort((a, b) =>
      a.agent.localeCompare(b.agent))).toEqual([
      {
        agent: "codex",
        file: "/opt/agent-collab/bin/codex",
        args: [
          "exec", "--ignore-user-config", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="xhigh"',
          "-C", "/repo", "-s", "read-only", "--json", "-",
        ],
        cwd: "/repo",
        stdin: probeInput("xhigh"),
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
        stdin: probeInput("high"),
        timeoutMs: 3_000,
        shell: false,
        killProcessGroup: true,
      },
    ]);

    gates.codex.resolve(success("codex"));
    gates.grok.resolve(success("grok"));
    await expect(result).resolves.toEqual({
      results: {
        grok: { health: "healthy", ready: true, failures: [] },
        codex: { health: "healthy", ready: true, failures: [] },
      },
    });
  });

  it("never invokes a disabled provider", async () => {
    const execute = vi.fn(async (request: { agent: "grok" | "codex" }) => success(request.agent));
    const result = await runCapabilityProbes({
      providers: { ...providers, grok: { ...providers.grok, enabled: false } },
      timeoutMs: 3_000,
      runner: { execute },
      sessionIdFactory: () => sessionId,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ agent: "codex" });
    expect(result.results.grok).toEqual({
      health: "disabled",
      ready: false,
      failures: ["provider_disabled"],
    });
  });

  it("bounds hung probes and classifies missing CLIs without retrying", async () => {
    vi.useFakeTimers();
    const never = new Promise<ReturnType<typeof success>>(() => undefined);
    const execute = vi.fn((request: { agent: "grok" | "codex" }) =>
      request.agent === "grok"
        ? never
        : Promise.reject(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    const result = run({ execute });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toEqual({
      results: {
        grok: { health: "unavailable", ready: false, failures: ["probe_timeout"] },
        codex: { health: "unavailable", ready: false, failures: ["cli_missing"] },
      },
    });
    expect(execute).toHaveBeenCalledTimes(2);
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
  ] as const)("fails closed for %s", async (_name, agent, stdout) => {
    const execute = vi.fn(async (request: { agent: "grok" | "codex" }) =>
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
    const execute = vi.fn(async (request: { agent: "grok" | "codex" }) => {
      if (request.agent === "grok") return success("grok");
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
