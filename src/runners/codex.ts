import { isAbsolute } from "node:path";
import type { ApprovalScope, Effort } from "../domain/routing.js";
import type { CommandSpec } from "./provider-command.js";

export interface CodexCommandInput {
  binary: string;
  cwd: string;
  prompt: string;
  approvalScope: ApprovalScope;
  approvalReference?: string;
  effort: Effort;
  timeoutMs: number;
}

const MODEL = "gpt-5.6-sol";
const MAX_RESULT_BYTES = 1024 * 1024;
const EXECUTABLE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function buildCodexCommand(input: CodexCommandInput): CommandSpec {
  if (!isAbsolute(input.cwd)) throw new Error("Codex cwd must be absolute");
  if (!EXECUTABLE_EFFORTS.has(input.effort)) {
    throw new Error("Codex/Sol executable effort must not exceed xhigh");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Codex timeout must be a positive integer");
  }
  if (input.approvalScope !== "workspace-read" && !input.approvalReference?.trim()) {
    throw new Error(`${input.approvalScope} execution requires an explicit approval reference`);
  }
  const sandbox =
    input.approvalScope === "workspace-read"
      ? "read-only"
      : input.approvalScope === "workspace-write"
        ? "workspace-write"
        : "danger-full-access";
  return {
    file: input.binary,
    args: [
      "exec",
      "--ignore-user-config",
      "-m",
      MODEL,
      "-c",
      `model_reasoning_effort="${input.effort}"`,
      "-C",
      input.cwd,
      "-s",
      sandbox,
      "--json",
      "-",
    ],
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false,
    timeoutMs: input.timeoutMs,
    killProcessGroup: true,
  };
}

export function normalizeCodexResult(stdout: string): { text: string; model: "gpt-5.6-sol" } {
  if (Buffer.byteLength(stdout, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Codex result exceeds the bounded parser limit");
  }
  let records: Record<string, unknown>[];
  try {
    records = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const parsed = record(JSON.parse(line));
      if (!parsed) throw new Error("record is not an object");
      return parsed;
    });
  }
  catch { throw new Error("malformed Codex JSONL parse"); }
  const sessions = records
    .filter((item) => item.type === "session_meta")
    .map((item) => record(item.payload));
  if (sessions.length !== 1 || sessions[0]?.model !== MODEL) {
    throw new Error(`model identity mismatch: ${String(sessions[0]?.model)}`);
  }
  const texts: string[] = [];
  for (const item of records) {
    if (item.type !== "response_item") continue;
    const payload = record(item.payload);
    if (payload?.type !== "message" || payload.role !== "assistant" || !Array.isArray(payload.content)) continue;
    for (const rawPart of payload.content) {
      const part = record(rawPart);
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (!texts.length) throw new Error("incomplete Codex stream: missing result");
  return { text: texts.join("\n"), model: MODEL };
}
