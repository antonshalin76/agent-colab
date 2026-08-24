import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Stage } from "../domain/routing.js";
import type { CommandSpec } from "./provider-command.js";

export type GrokEffort = "low" | "medium" | "high" | "xhigh";
export type GrokApprovalScope = "workspace-read" | "workspace-write" | "external";

export interface GrokCommandInput {
  binary: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  approvalScope: GrokApprovalScope;
  approvalReference?: string;
  effort: GrokEffort;
  toolAllowlist?: readonly string[];
  timeoutMs: number;
}

export interface NormalizedGrokResult {
  text: string;
  model: "grok-4.6";
  effort: GrokEffort;
  protocolVersion: string;
}

const DEFAULT_GROK_BINARY = join(homedir(), ".local", "bin", "grok");
const MODEL = "grok-4.6";
const READ_TOOLS = ["read_file", "grep", "list_dir"] as const;
const WRITE_TOOLS = ["run_terminal_cmd", "search_replace"] as const;
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
const MUTATING_STAGES: ReadonlySet<Stage> = new Set([
  "planning",
  "prd",
  "architecture",
  "ui_ux",
  "bdd",
  "tdd_coding",
  "unit_testing",
  "e2e_infrastructure",
  "e2e_testing",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESULT_BYTES = 1024 * 1024;
const EXECUTABLE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function writeTools(input: GrokCommandInput): readonly string[] {
  if (!input.approvalReference?.trim()) {
    throw new Error("workspace write requires an explicit approval reference");
  }
  const tools = input.toolAllowlist;
  if (!tools?.length) throw new Error("workspace write requires a stage tool allowlist");
  if (new Set(tools).size !== tools.length) throw new Error("tool allowlist contains duplicates");
  for (const tool of tools) {
    if (!BUILTIN_TOOLS.has(tool)) throw new Error(`tool allowlist contains unsupported built-in: ${tool}`);
  }
  return tools;
}

export function grokWorkspaceWriteToolAllowlist(stage: Stage): readonly string[] {
  return MUTATING_STAGES.has(stage)
    ? [...READ_TOOLS, ...WRITE_TOOLS]
    : [...READ_TOOLS];
}

export function buildGrokCommand(input: GrokCommandInput): CommandSpec {
  if (!isAbsolute(input.binary)) throw new Error("Grok binary must be absolute");
  const trustedBinary = process.env.AGENT_COLLAB_GROK_BIN ?? DEFAULT_GROK_BINARY;
  if (input.binary !== trustedBinary) throw new Error(`Grok binary identity mismatch: ${input.binary}`);
  if (!isAbsolute(input.cwd)) throw new Error("Grok cwd must be absolute");
  if (!EXECUTABLE_EFFORTS.has(input.effort)) {
    throw new Error("Grok effort exceeds the advertised grok-4.6 capability");
  }
  if (!UUID.test(input.sessionId)) throw new Error("Grok session id must be a fresh UUIDv4");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Grok timeout must be a positive integer");
  }
  if (input.approvalScope === "external") {
    throw new Error("external scope is not a supported Grok command sandbox");
  }
  if (input.approvalScope === "workspace-read" && input.toolAllowlist !== undefined) {
    throw new Error("read scope uses the fixed least-privilege tool allowlist");
  }

  const args = [
    "--cwd",
    input.cwd,
    "--model",
    MODEL,
    "--reasoning-effort",
    input.effort,
    "--prompt-file",
    "/dev/stdin",
    "--verbatim",
    "--output-format",
    "json",
    "--session-id",
    input.sessionId,
    "--no-subagents",
    "--disable-web-search",
    "--deny",
    "mcp__*",
  ];
  if (input.approvalScope === "workspace-read") {
    args.push(
      "--sandbox",
      "strict",
      "--permission-mode",
      "dontAsk",
      "--tools",
      READ_TOOLS.join(","),
    );
  } else {
    args.push(
      "--sandbox",
      "strict",
      "--always-approve",
      "--tools",
      writeTools(input).join(","),
    );
  }
  return {
    file: input.binary,
    args,
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false,
    timeoutMs: input.timeoutMs,
    killProcessGroup: true,
  };
}

export function normalizeGrokResult(
  stdout: string,
  expected: { expectedEffort: GrokEffort; expectedProtocolVersion: string },
): NormalizedGrokResult {
  if (Buffer.byteLength(stdout, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Grok result exceeds the bounded parser limit");
  }
  let envelope: Record<string, unknown> | null;
  try {
    envelope = record(JSON.parse(stdout));
  } catch {
    throw new Error("malformed Grok terminal JSON parse");
  }
  if (!envelope || typeof envelope.text !== "string") {
    throw new Error("incomplete Grok terminal result");
  }
  if (envelope.stopReason !== "end_turn") {
    throw new Error("Grok result has an error or nonterminal stop reason");
  }
  const usage = record(envelope.modelUsage);
  if (!usage || Object.keys(usage).length !== 1 || !record(usage[MODEL])) {
    throw new Error("model identity mismatch: expected grok-4.6 modelUsage");
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(envelope.text));
  } catch {
    throw new Error("malformed Grok visible result parse");
  }
  if (!payload || payload.protocolVersion !== expected.expectedProtocolVersion) {
    throw new Error("Grok protocol mismatch");
  }
  if (payload.reasoningEffort !== expected.expectedEffort) {
    throw new Error("Grok reasoning effort mismatch");
  }
  if (typeof payload.visibleText !== "string" || !payload.visibleText.trim()) {
    throw new Error("incomplete Grok result: missing visible text");
  }
  return {
    text: payload.visibleText,
    model: MODEL,
    effort: expected.expectedEffort,
    protocolVersion: expected.expectedProtocolVersion,
  };
}
