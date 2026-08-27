import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { adaptGrokRecord } from "../src/history/adapters.js";
import { HistoryIndex } from "../src/history/index.js";
import type { ActiveAgentId, HistorySourceAgent } from "../src/history/types.js";
import { HistoryVisibilityPolicy } from "../src/history/visibility-policy.js";
import {
  buildGrokCommand,
  normalizeGrokResult,
} from "../src/runners/grok.js";
import {
  prepareCommandInput,
  type CommandSpec,
} from "../src/runners/provider-command.js";

const roots: string[] = [];
const binary = "/home/anton/.local/bin/grok";
const sessionId = "7dc8d8a4-8c31-4d7f-bda7-cb6b60453fc1";
const protocolVersion = "agent-collab/v2";
const readTools = ["read_file", "grep", "list_dir"] as const;
const efforts = ["low", "medium", "high", "xhigh"] as const;
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "history");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-grok-v2-"));
  roots.push(root);
  return root;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function snapshot(path: string) {
  const stat = statSync(path);
  return {
    bytes: readFileSync(path),
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function terminalResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stopReason: "end_turn",
    sessionId,
    modelUsage: {
      "grok-4.6": { inputTokens: 17, outputTokens: 5 },
    },
    text: JSON.stringify({
      protocolVersion,
      reasoningEffort: "xhigh",
      visibleText: "visible Grok answer",
    }),
    thought: "PRIVATE_THOUGHT_SENTINEL",
    reasoning: { encrypted_content: "ENCRYPTED_REASONING_SENTINEL" },
    tool_arguments: { path: "/private/TOOL_ARGUMENT_SENTINEL" },
    tool_result: "TOOL_RESULT_SENTINEL",
    raw: { providerRecord: "RAW_RECORD_SENTINEL" },
    ...overrides,
  });
}

describe("BDD-8 exact provider-neutral Grok runner contract", () => {
  it.each(efforts)("builds the exact least-privilege read command at %s effort", (effort) => {
    const command = buildGrokCommand({
      binary,
      cwd: "/repo",
      prompt: "audit",
      sessionId,
      approvalScope: "workspace-read",
      effort,
      timeoutMs: 90_000,
    });
    const expected: CommandSpec = {
      file: binary,
      args: [
        "--cwd",
        "/repo",
        "--model",
        "grok-4.6",
        "--reasoning-effort",
        effort,
        "--prompt-file",
        "/dev/stdin",
        "--verbatim",
        "--output-format",
        "json",
        "--session-id",
        sessionId,
        "--no-subagents",
        "--disable-web-search",
        "--deny",
        "mcp__*",
        "--sandbox",
        "strict",
        "--permission-mode",
        "dontAsk",
        "--tools",
        readTools.join(","),
      ],
      cwd: "/repo",
      stdin: "audit",
      shell: false,
      timeoutMs: 90_000,
      killProcessGroup: true,
      promptFileArgIndex: 7,
    };
    expect(command).toEqual(expected);
    expect(command.args).not.toContain("--always-approve");
  });

  it("does not mint write or external authority inside a command builder", () => {
    const base = {
      binary,
      cwd: "/repo",
      prompt: "implement",
      sessionId,
      effort: "high" as const,
      timeoutMs: 90_000,
    };
    expect(() => buildGrokCommand({
      ...base,
      approvalScope: "workspace-write",
      toolAllowlist: ["run_terminal_cmd"],
    } as unknown as Parameters<typeof buildGrokCommand>[0])).toThrow(/workspace-read/i);
    expect(() => buildGrokCommand({
      ...base,
      approvalScope: "external",
      approvalReference: "approval:external",
    } as unknown as Parameters<typeof buildGrokCommand>[0])).toThrow(/workspace-read/i);
  });

  it("rejects an invalid prompt-file argument index before creating temporary state", () => {
    expect(() => prepareCommandInput({
      file: binary,
      args: ["--prompt-file", "/dev/stdin"],
      cwd: "/repo",
      stdin: "audit",
      shell: false,
      timeoutMs: 90_000,
      killProcessGroup: true,
      promptFileArgIndex: 0,
    })).toThrow(/promptFileArgIndex/i);
  });

  it("accepts only terminal exact-model protocol evidence and returns visible text", () => {
    const result = normalizeGrokResult(terminalResult(), {
      expectedEffort: "xhigh",
      expectedProtocolVersion: protocolVersion,
    });
    expect(result).toEqual({
      text: "visible Grok answer",
      model: "grok-4.6",
      providerReportedModel: "grok-4.6",
      modelProvenance: "provider_reported_alias",
      effort: "xhigh",
      protocolVersion,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_THOUGHT|ENCRYPTED_REASONING|TOOL_ARGUMENT|TOOL_RESULT|RAW_RECORD/,
    );
  });

  it("prefers Grok 1.0.5 structuredOutput over concatenated per-turn text", () => {
    const result = normalizeGrokResult(terminalResult({
      text: `${JSON.stringify({
        protocolVersion,
        reasoningEffort: "xhigh",
        visibleText: "progress",
      })}${JSON.stringify({
        protocolVersion,
        reasoningEffort: "xhigh",
        visibleText: "final",
      })}`,
      structuredOutput: {
        protocolVersion,
        reasoningEffort: "xhigh",
        visibleText: "final",
      },
    }), {
      expectedEffort: "xhigh",
      expectedProtocolVersion: protocolVersion,
    });

    expect(result.text).toBe("final");
  });

  it.each([
    ["malformed", "not-json", /malformed|parse/i],
    [
      "wrong model",
      terminalResult({ modelUsage: { "grok-4.5": { inputTokens: 1, outputTokens: 1 } } }),
      /model identity/i,
    ],
    [
      "wrong protocol",
      terminalResult({
          text: JSON.stringify({
          protocolVersion: "untrusted/v0",
          reasoningEffort: "xhigh",
          visibleText: "visible Grok answer",
        }),
      }),
      /protocol/i,
    ],
    [
      "effort downgrade",
      terminalResult({
          text: JSON.stringify({
          protocolVersion,
          reasoningEffort: "high",
          visibleText: "visible Grok answer",
        }),
      }),
      /effort/i,
    ],
    ["provider error", terminalResult({ stopReason: "error" }), /error|stop/i],
    [
      "nonterminal stop",
      terminalResult({ stopReason: "tool_use" }),
      /terminal|stop/i,
    ],
    [
      "missing visible text",
      terminalResult({
        text: JSON.stringify({ protocolVersion, reasoningEffort: "xhigh" }),
      }),
      /incomplete|visible|result/i,
    ],
  ] as const)("fails closed for %s Grok output", (_name, stdout, error) => {
    expect(() => normalizeGrokResult(stdout, {
      expectedEffort: "xhigh",
      expectedProtocolVersion: protocolVersion,
    })).toThrow(error);
  });
});

describe("BDD-7/11 Grok native history and identity separation", () => {
  it("adapts the installed Grok 1.0.5 user, assistant, tool, and reasoning record shapes", () => {
    const context = { project: "/repo", sourcePath: "/repo/chat_history.jsonl",
      sourceLine: 7, sessionId: "native-session" };
    const visible = [
      ...adaptGrokRecord({ type: "user", content: [{ type: "text", text: "native question" }] }, context),
      ...adaptGrokRecord({ type: "assistant", content: "native answer", reasoning_effort: "high",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: { path: "/private" } }] }, context),
      ...adaptGrokRecord({ type: "reasoning", summary: [{ text: "hidden reasoning" }],
        encrypted_content: "hidden" }, context),
      ...adaptGrokRecord({ type: "tool_result", tool_call_id: "call-1", content: "private result" }, context),
      ...adaptGrokRecord({ type: "user", synthetic_reason: "environment_context",
        content: [{ type: "text", text: "privileged synthetic input" }] }, context),
    ];
    const policy = new HistoryVisibilityPolicy();
    const projected = visible.flatMap((event) => event.type === "candidate"
      ? [policy.project(event.candidate)].filter((row) => row !== null) : []);
    expect(projected.map((row) => row!.content)).toEqual(["native question", "native answer"]);
    expect(visible.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(visible.filter((event) => event.type === "tool_result")).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toMatch(/hidden reasoning|private result|privileged synthetic|\/private/);
  });

  it("indexes the sanitized installed-format Grok 1.0.5 transcript fixture", async () => {
    const root = makeRoot();
    const source = join(root, "chat_history.jsonl");
    writeFileSync(source, readFileSync(join(fixtureRoot, "grok-1.0.5-thread.jsonl")));
    const index = new HistoryIndex(join(root, "history.db"), {
      visibilityPolicy: new HistoryVisibilityPolicy(),
    });
    try {
      const result = await index.indexGrokFile(source, root);
      expect(result.added).toBe(3);
      expect(index.search({ requester: "codex", project: root }).map((row) => [row.kind, row.content]))
        .toEqual([
          ["message", "native visible question"],
          ["message", "native visible answer"],
          ["tool_summary", "read_file: completed"],
        ]);
    } finally { index.close(); }
  });

  it("keeps execution identity distinct from legacy history provenance", () => {
    const active: Record<ActiveAgentId, true> = { grok: true, codex: true };
    const sources: Record<HistorySourceAgent, true> = {
      grok: true,
      codex: true,
      claude_legacy: true,
    };

    expect(Object.keys(active).sort()).toEqual(["codex", "grok"]);
    expect(Object.keys(sources).sort()).toEqual(["claude_legacy", "codex", "grok"]);
    expect(active).not.toHaveProperty("claude_legacy");
  });

  it("classifies hidden native blocks before the central visibility boundary", () => {
    const events = adaptGrokRecord(
      {
        type: "message",
        id: "grok-message-1",
        role: "assistant",
        timestamp: "2026-08-23T05:00:00.000Z",
        content: [
          { type: "text", text: "visible Grok text" },
          { type: "thought", text: "PRIVATE_GROK_THOUGHT" },
          { type: "reasoning", text: "PRIVATE_GROK_REASONING" },
          { type: "encrypted_content", data: "PRIVATE_GROK_ENCRYPTED" },
          { type: "tool_arguments", arguments: { path: "/private/GROK_TOOL_PATH" } },
          { type: "tool_result", result: "PRIVATE_GROK_TOOL_RESULT" },
        ],
      },
      {
        project: "/repo",
        sourcePath: "/repo/.grok/session.jsonl",
        sourceLine: 2,
        sessionId: "grok-session-1",
      },
    );
    const policy = new HistoryVisibilityPolicy();
    const projected = events.flatMap((event) => {
      if (event.type !== "candidate") return [];
      const row = policy.project(event.candidate);
      return row === null ? [] : [row];
    });

    expect(projected).toEqual([
      expect.objectContaining({
        sourceAgent: "grok",
        role: "assistant",
        content: "visible Grok text",
        sourceLine: 2,
        timestamp: "2026-08-23T05:00:00.000Z",
        trust: "untrusted",
      }),
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_GROK|GROK_TOOL_PATH/);
  });

  it("indexes only redacted visible text with reciprocal project parity and immutable source", async () => {
    const root = makeRoot();
    const source = join(root, "grok-session.jsonl");
    const database = join(root, "history.db");
    const bearerSecret = "GROK_BEARER_SECRET_SENTINEL";
    const apiSecret = "GROK_API_SECRET_SENTINEL";
    const bareSecret = "sk-ant-GROKANTHROPICSECRET123";
    const hiddenThought = "GROK_PRIVATE_THOUGHT_SENTINEL";
    const toolArgument = "GROK_TOOL_ARGUMENT_SENTINEL";
    const toolResult = "GROK_TOOL_RESULT_SENTINEL";
    const records = [
      JSON.stringify({ type: "session_meta", payload: { id: "grok-session-1", cwd: root } }),
      JSON.stringify({
        type: "message",
        id: "grok-user-1",
        role: "user",
        timestamp: "2026-08-23T05:10:00.000Z",
        content: [{ type: "text", text: "Grok visible question" }],
      }),
      JSON.stringify({
        type: "message",
        id: "grok-assistant-1",
        role: "assistant",
        timestamp: "2026-08-23T05:10:01.000Z",
        content: [
          { type: "text", text: "Grok visible answer" },
          { type: "thought", text: hiddenThought },
          { type: "encrypted_content", data: "GROK_ENCRYPTED_SENTINEL" },
        ],
      }),
      JSON.stringify({
        type: "message",
        id: "grok-secret-1",
        role: "user",
        timestamp: "2026-08-23T05:10:02.000Z",
        content: [{ type: "text", text: `request Authorization: Bearer ${bearerSecret}` }],
      }),
      JSON.stringify({
        type: "message",
        id: "grok-secret-2",
        role: "assistant",
        timestamp: "2026-08-23T05:10:03.000Z",
        content: [{ type: "text", text: `configuration api_key=${apiSecret}` }],
      }),
      JSON.stringify({
        type: "message",
        id: "grok-secret-3",
        role: "assistant",
        timestamp: "2026-08-23T05:10:04.000Z",
        content: [{ type: "text", text: `anthropic ${bareSecret}` }],
      }),
      JSON.stringify({
        type: "message",
        id: "grok-system-1",
        role: "system",
        content: [{ type: "text", text: "GROK_PRIVILEGED_INSTRUCTION_SENTINEL" }],
      }),
      JSON.stringify({
        type: "tool_call",
        id: "grok-call-1",
        name: "read_file",
        arguments: { path: `/private/${toolArgument}` },
      }),
      JSON.stringify({
        type: "tool_result",
        call_id: "grok-call-1",
        status: "completed",
        output: toolResult,
      }),
      "{malformed-json",
      JSON.stringify({
        type: "message",
        id: "grok-partial",
        role: "assistant",
        content: [{ type: "text", text: "GROK_PARTIAL_SENTINEL" }],
      }),
    ];
    writeFileSync(source, records.slice(0, -1).join("\n") + "\n" + records.at(-1), { mode: 0o600 });
    const before = snapshot(source);
    const index = new HistoryIndex(database, { visibilityPolicy: new HistoryVisibilityPolicy() });

    const indexed = await index.indexGrokFile(source, root);
    expect(snapshot(source)).toEqual(before);
    expect(indexed).toMatchObject({ added: 6, duplicates: 0, malformed: 1, partial: true });

    const fromGrok = index.search({ requester: "grok", project: root });
    const fromCodex = index.search({ requester: "codex", project: root });
    expect(fromGrok).toEqual(fromCodex);
    expect(fromGrok).toEqual([
      {
        sourceAgent: "grok",
        namespace: "grok_native",
        kind: "message",
        sessionId: "grok-session-1",
        role: "user",
        content: "Grok visible question",
        sourcePath: source,
        sourceLine: 2,
        timestamp: "2026-08-23T05:10:00.000Z",
        recordKey: "message:grok-user-1:text:0",
        contentHash: digest("Grok visible question"),
        trust: "untrusted",
      },
      {
        sourceAgent: "grok",
        namespace: "grok_native",
        kind: "message",
        sessionId: "grok-session-1",
        role: "assistant",
        content: "Grok visible answer",
        sourcePath: source,
        sourceLine: 3,
        timestamp: "2026-08-23T05:10:01.000Z",
        recordKey: "message:grok-assistant-1:text:0",
        contentHash: digest("Grok visible answer"),
        trust: "untrusted",
      },
      {
        sourceAgent: "grok",
        namespace: "grok_native",
        kind: "message",
        sessionId: "grok-session-1",
        role: "user",
        content: "request Authorization: Bearer [REDACTED]",
        sourcePath: source,
        sourceLine: 4,
        timestamp: "2026-08-23T05:10:02.000Z",
        recordKey: "message:grok-secret-1:text:0",
        contentHash: digest("request Authorization: Bearer [REDACTED]"),
        trust: "untrusted",
      },
      {
        sourceAgent: "grok",
        namespace: "grok_native",
        kind: "message",
        sessionId: "grok-session-1",
        role: "assistant",
        content: "configuration api_key=[REDACTED]",
        sourcePath: source,
        sourceLine: 5,
        timestamp: "2026-08-23T05:10:03.000Z",
        recordKey: "message:grok-secret-2:text:0",
        contentHash: digest("configuration api_key=[REDACTED]"),
        trust: "untrusted",
      },
      {
        sourceAgent: "grok",
        namespace: "grok_native",
        kind: "message",
        sessionId: "grok-session-1",
        role: "assistant",
        content: "anthropic [REDACTED]",
        sourcePath: source,
        sourceLine: 6,
        timestamp: "2026-08-23T05:10:04.000Z",
        recordKey: "message:grok-secret-3:text:0",
        contentHash: digest("anthropic [REDACTED]"),
        trust: "untrusted",
      },
      {
        sourceAgent: "grok",
        namespace: "grok_native",
        kind: "tool_summary",
        sessionId: "grok-session-1",
        role: "assistant",
        content: "read_file: completed",
        sourcePath: source,
        sourceLine: 8,
        timestamp: null,
        recordKey: "tool:grok-call-1",
        contentHash: digest("read_file: completed"),
        trust: "untrusted",
      },
    ]);
    expect(index.search({ requester: "grok", project: "/different-project" })).toEqual([]);
    index.close();

    const persisted = [database, `${database}-wal`, `${database}-shm`]
      .filter(existsSync)
      .map((path) => readFileSync(path).toString("latin1"))
      .join("");
    for (const forbidden of [
      bearerSecret,
      apiSecret,
      bareSecret,
      hiddenThought,
      toolArgument,
      toolResult,
      "GROK_ENCRYPTED_SENTINEL",
      "GROK_PRIVILEGED_INSTRUCTION_SENTINEL",
      "GROK_PARTIAL_SENTINEL",
    ]) {
      expect(persisted).not.toContain(forbidden);
    }
  });
});
