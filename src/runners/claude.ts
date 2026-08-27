import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ProviderTransportFailure } from "../domain/outcomes.js";
import { REVIEW_VERDICT_JSON_SCHEMA } from "../domain/review-verdict.js";
import type { ApprovalScope, Effort } from "../domain/routing.js";
import type { CommandSpec } from "./provider-command.js";

export interface ClaudeCommandInput {
  binary: string;
  cwd: string;
  prompt: string;
  approvalScope: ApprovalScope;
  sessionId: string;
  effort: Effort;
  timeoutMs: number;
}

export interface NormalizedClaudeResult {
  text: string;
  model: "glm-5.3";
  modelProvenance: "command_pinned";
  effort: Effort;
  effortProvenance: "command_pinned";
  sessionId: string;
}

const MODEL = "glm-5.3";
const DEFAULT_CLAUDE_BINARY = join(homedir(), ".local", "bin", "claude");
const EXECUTABLE_EFFORTS: ReadonlySet<string> = new Set([
  "low", "medium", "high", "xhigh", "max",
]);
const INPUT_KEYS = new Set([
  "binary", "cwd", "prompt", "approvalScope", "sessionId", "effort", "timeoutMs",
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESULT_BYTES = 1024 * 1024;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export function buildClaudeCommand(input: ClaudeCommandInput): CommandSpec {
  const untrusted = input as ClaudeCommandInput & Record<string, unknown>;
  const callerKeys = Object.keys(untrusted).filter((key) => !INPUT_KEYS.has(key));
  if (callerKeys.length > 0) {
    throw new Error(`Claude command rejects caller-controlled flags: ${callerKeys.join(", ")}`);
  }
  if (input.approvalScope !== "workspace-read") {
    throw new Error("Claude command authority is fixed to workspace-read");
  }
  if (!isAbsolute(input.binary)) throw new Error("Claude binary must be absolute");
  const trustedBinary = process.env.AGENT_COLLAB_CLAUDE_BIN ?? DEFAULT_CLAUDE_BINARY;
  if (input.binary !== trustedBinary) {
    throw new Error(`Claude binary identity mismatch: ${input.binary}`);
  }
  if (!isAbsolute(input.cwd)) throw new Error("Claude cwd must be absolute");
  if (!EXECUTABLE_EFFORTS.has(input.effort)) {
    throw new Error("Claude effort exceeds the advertised GLM-5.3 capability");
  }
  if (!UUID_V4.test(input.sessionId)) throw new Error("Claude session id must be a fresh UUIDv4");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Claude timeout must be a positive integer");
  }
  return {
    file: input.binary,
    args: [
      "-p",
      "--model", MODEL,
      "--effort", input.effort,
      "--session-id", input.sessionId,
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
      "--json-schema", JSON.stringify(REVIEW_VERDICT_JSON_SCHEMA),
    ],
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false,
    timeoutMs: input.timeoutMs,
    killProcessGroup: true,
  };
}

const transportFailure = (message: string): never => {
  throw new ProviderTransportFailure(message, "task_failure");
};

export function normalizeClaudeResult(
  stdout: string,
  expected: { expectedSessionId: string; expectedEffort: Effort },
): NormalizedClaudeResult {
  if (Buffer.byteLength(stdout, "utf8") > MAX_RESULT_BYTES) {
    return transportFailure("Claude result exceeds the bounded parser byte limit");
  }
  let envelope: Record<string, unknown> | null;
  try { envelope = record(JSON.parse(stdout)); }
  catch { return transportFailure("malformed Claude result JSON"); }
  if (!envelope || envelope.type !== "result" || envelope.subtype !== "success" ||
      envelope.is_error !== false) {
    return transportFailure("Claude result is not one successful terminal envelope");
  }
  if (envelope.session_id !== expected.expectedSessionId) {
    return transportFailure("Claude result session identity mismatch");
  }
  if (envelope.model !== undefined && envelope.model !== MODEL) {
    return transportFailure("Claude reported model conflicts with command-pinned GLM-5.3");
  }
  if (envelope.effort !== undefined && envelope.effort !== expected.expectedEffort) {
    return transportFailure("Claude reported effort conflicts with the command-pinned effort");
  }
  const structured = record(envelope.structured_output);
  if (!structured) return transportFailure("Claude result is missing structured output");
  if (typeof envelope.result !== "string") {
    return transportFailure("Claude result is missing its visible JSON result");
  }
  let visible: unknown;
  try { visible = JSON.parse(envelope.result); }
  catch { return transportFailure("Claude visible result is not JSON"); }
  if (!isDeepStrictEqual(visible, structured)) {
    return transportFailure("Claude visible and structured results conflict");
  }
  return {
    text: JSON.stringify(structured),
    model: MODEL,
    modelProvenance: "command_pinned",
    effort: expected.expectedEffort,
    effortProvenance: "command_pinned",
    sessionId: expected.expectedSessionId,
  };
}
