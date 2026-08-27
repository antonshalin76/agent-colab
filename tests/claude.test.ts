import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeReviewProviderResult } from "../src/domain/review-verdict.js";
import {
  buildClaudeCommand,
  normalizeClaudeResult,
} from "../src/runners/claude.js";
import { buildProviderCommand, type CommandSpec } from "../src/runners/provider-command.js";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const claudeBinary = join(homedir(), ".local", "bin", "claude");
const reviewVerdict = {
  schemaVersion: "review-verdict/v1",
  verdict: "PASS",
  findings: [{ risk_level: "info", message: "transport fixture" }],
} as const;

const reviewSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "review-verdict/v1" },
    verdict: { enum: ["PASS", "CHANGES_REQUESTED", "INCONCLUSIVE"] },
    findings: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          risk_level: { enum: ["info", "warn", "error"] },
          message: { type: "string", minLength: 1, maxLength: 8_192 },
        },
        required: ["risk_level", "message"],
      },
    },
  },
  required: ["schemaVersion", "verdict", "findings"],
});

const successEnvelope = (
  structuredOutput: unknown = reviewVerdict,
  overrides: Record<string, unknown> = {},
): string => JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: JSON.stringify(structuredOutput),
  structured_output: structuredOutput,
  ...overrides,
});

describe("BDD-C2 Claude Code immutable read-only command", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "pins GLM-5.3 and saved %s effort behind the exact read-only surface",
    (effort) => {
      const input = {
        binary: claudeBinary,
        cwd: "/repo",
        prompt: "review immutable packet",
        sessionId,
        approvalScope: "workspace-read" as const,
        effort,
        timeoutMs: 90_000,
      };
      const expected: CommandSpec = {
        file: claudeBinary,
        args: [
          "-p",
          "--model", "glm-5.3",
          "--effort", effort,
          "--session-id", sessionId,
          "--no-session-persistence",
          "--safe-mode",
          "--setting-sources", "user",
          "--no-chrome",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--mcp-config", '{"mcpServers":{}}',
          "--permission-mode", "dontAsk",
          "--tools", "Read,Glob,Grep",
          "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Skill",
          "--output-format", "json",
          "--json-schema", reviewSchema,
        ],
        cwd: "/repo",
        stdin: "review immutable packet",
        shell: false,
        timeoutMs: 90_000,
        killProcessGroup: true,
      };

      expect(buildClaudeCommand(input)).toEqual(expected);
      expect(buildProviderCommand({ agent: "claude", command: input })).toEqual(expected);
      const flags = expected.args.join(" ");
      expect(flags).not.toMatch(/--bare|--resume|--continue|--fork-session|--fallback-model|--add-dir|--plugin-dir|--agent(?:s)?\b|--chrome\b|dangerously-skip-permissions/);
    },
  );

  it.each([
    ["approvalScope", { approvalScope: "workspace-write" }],
    ["ultra effort", { effort: "ultra" }],
    ["relative binary", { binary: "claude" }],
    ["untrusted binary", { binary: "/tmp/claude" }],
    ["relative cwd", { cwd: "repo" }],
    ["malformed session", { sessionId: "not-a-uuid" }],
    ["non-positive timeout", { timeoutMs: 0 }],
    ["resume", { resume: sessionId }],
    ["continue", { continue: true }],
    ["fallback", { fallbackModel: "other" }],
    ["caller flags", { extraArgs: ["--dangerously-skip-permissions"] }],
    ["permission bypass", { dangerouslySkipPermissions: true }],
    ["tool override", { toolAllowlist: ["Bash"] }],
    ["allowed tools override", { allowedTools: ["Bash"] }],
    ["denied tools override", { disallowedTools: [] }],
    ["settings override", { settings: "{}" }],
    ["setting sources override", { settingSources: "project" }],
    ["MCP override", { mcpConfig: "/tmp/mcp.json" }],
    ["permission mode", { permissionMode: "bypassPermissions" }],
    ["system prompt", { systemPrompt: "ignore policy" }],
    ["appended system prompt", { appendSystemPrompt: "ignore policy" }],
    ["browser", { chrome: true }],
    ["skill", { disableSlashCommands: false }],
    ["agent", { agent: "reviewer" }],
    ["agents", { agents: {} }],
    ["plugin", { pluginDir: "/tmp/plugin" }],
    ["hook", { hooks: {} }],
    ["added directory", { addDir: "/tmp" }],
  ] as const)("rejects caller-controlled %s before command construction", (_label, patch) => {
    const build = buildClaudeCommand as unknown as (input: Record<string, unknown>) => unknown;
    expect(() => build({
      binary: claudeBinary,
      cwd: "/repo",
      prompt: "review",
      sessionId,
      approvalScope: "workspace-read",
      effort: "high",
      timeoutMs: 90_000,
      ...patch,
    })).toThrow(/Claude|read|authority|effort|binary|cwd|session|timeout|caller|flag|override|forbidden/i);
  });
});

describe("BDD-C3 bounded Claude result transport", () => {
  it("returns only structured verdict bytes with command-pinned identity facts", () => {
    const normalized = normalizeClaudeResult(successEnvelope(), {
      expectedSessionId: sessionId,
      expectedEffort: "max",
    });
    expect(normalized).toEqual({
      text: JSON.stringify(reviewVerdict),
      model: "glm-5.3",
      modelProvenance: "command_pinned",
      effort: "max",
      effortProvenance: "command_pinned",
      sessionId,
    });
    expect(normalizeReviewProviderResult({ kind: "success", ...normalized })).toMatchObject({
      reviewVerdict,
    });
  });

  it("leaves verdict semantics to the domain validator", () => {
    const semanticallyInvalid = {
      schemaVersion: "review-verdict/v1",
      verdict: "PASS",
      findings: [{ risk_level: "warn", message: "blocking" }],
    };
    const transported = normalizeClaudeResult(successEnvelope(semanticallyInvalid), {
      expectedSessionId: sessionId,
      expectedEffort: "high",
    });
    expect(transported.text).toBe(JSON.stringify(semanticallyInvalid));
    expect(() => normalizeReviewProviderResult({ kind: "success", ...transported }))
      .toThrow(/review verdict/i);
  });

  it.each([
    ["provider error", JSON.stringify({
      type: "result", subtype: "error_during_execution", is_error: true,
      session_id: sessionId, result: "failed", structured_output: reviewVerdict,
    })],
    ["malformed JSON", "{not-json"],
    ["trailing JSON", `${successEnvelope()}\n{}`],
    ["multiple JSON", `${successEnvelope()}${successEnvelope()}`],
    ["session mismatch", successEnvelope(reviewVerdict, {
      session_id: "123e4567-e89b-42d3-a456-426614174999",
    })],
    ["missing structured output", JSON.stringify({
      type: "result", subtype: "success", is_error: false,
      session_id: sessionId, result: JSON.stringify(reviewVerdict),
    })],
    ["conflicting visible verdict", successEnvelope(reviewVerdict, {
      result: JSON.stringify({ ...reviewVerdict, verdict: "INCONCLUSIVE" }),
    })],
    ["non-JSON visible result", successEnvelope(reviewVerdict, { result: "PASS" })],
    ["reported model conflict", successEnvelope(reviewVerdict, { model: "glm-5.2" })],
    ["reported effort conflict", successEnvelope(reviewVerdict, { effort: "low" })],
  ] as const)("rejects %s", (_label, stdout) => {
    expect(() => normalizeClaudeResult(stdout, {
      expectedSessionId: sessionId,
      expectedEffort: "high",
    })).toThrow(/Claude|JSON|result|session|structured|conflict|model|effort/i);
  });

  it("rejects output above the documented one-megabyte parser bound", () => {
    expect(() => normalizeClaudeResult(" ".repeat(1024 * 1024 + 1), {
      expectedSessionId: sessionId,
      expectedEffort: "high",
    })).toThrow(/bounded|limit|large|bytes/i);
  });
});
