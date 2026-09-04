import { isAbsolute } from "node:path";
import type { ApprovalScope, Effort } from "../domain/routing.js";
import type {
  UsageProvenance as CanonicalUsageProvenance,
  UsageTelemetry as CanonicalUsageTelemetry,
} from "../runtime/flow-telemetry.js";
import type { ProviderSessionRef } from "../runtime/provider-telemetry.js";
import type { CommandSpec } from "./provider-command.js";

export interface CodexCommandInput {
  binary: string;
  cwd: string;
  prompt: string;
  approvalScope: ApprovalScope;
  authorizationConsumerKey?: string;
  effort: Effort;
  timeoutMs: number;
}

const MODEL = "gpt-5.6-sol";
const MAX_RESULT_BYTES = 1024 * 1024;
const EXECUTABLE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

export type UsageProvenance = CanonicalUsageProvenance;
export type UsageTelemetry = CanonicalUsageTelemetry;

export interface NormalizedCodexBaseResult {
  text: string;
  model: "gpt-5.6-sol";
}
export interface NormalizedCodexResult extends NormalizedCodexBaseResult {
  readonly usage: UsageTelemetry;
  readonly providerSessionRef: ProviderSessionRef;
}
export interface NormalizedCodexEvalResult extends NormalizedCodexResult {
  modelProvenance: "command_pinned";
  effort: Effort;
  protocolVersion: string;
}

interface CodexEvalNormalizationOptions {
  includeUsage: true;
  expectedEffort: Effort;
  expectedProtocolVersion: string;
  pinnedModel: "gpt-5.6-sol";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reportedNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function usageTelemetry(source: Record<string, unknown> | null): UsageTelemetry {
  const values = {
    inputTokens: reportedNumber(source?.input_tokens),
    cachedInputTokens: reportedNumber(source?.cached_input_tokens),
    outputTokens: reportedNumber(source?.output_tokens),
    reasoningTokens: reportedNumber(source?.reasoning_output_tokens),
    totalTokens: reportedNumber(source?.total_tokens),
    costUsd: reportedNumber(source?.cost_usd),
  };
  return {
    ...values,
    provenance: {
      inputTokens: values.inputTokens === null ? "unavailable" : "provider_reported",
      cachedInputTokens: values.cachedInputTokens === null ? "unavailable" : "provider_reported",
      outputTokens: values.outputTokens === null ? "unavailable" : "provider_reported",
      reasoningTokens: values.reasoningTokens === null ? "unavailable" : "provider_reported",
      totalTokens: values.totalTokens === null ? "unavailable" : "provider_reported",
      costUsd: values.costUsd === null ? "unavailable" : "provider_reported",
    },
  };
}

export function buildCodexCommand(input: CodexCommandInput): CommandSpec {
  if (!isAbsolute(input.cwd)) throw new Error("Codex cwd must be absolute");
  if (!EXECUTABLE_EFFORTS.has(input.effort)) {
    throw new Error("Codex/Sol executable effort must not exceed xhigh");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("Codex timeout must be a positive integer");
  }
  if (input.approvalScope !== "workspace-read" && !input.authorizationConsumerKey?.trim()) {
    throw new Error(`${input.approvalScope} execution requires a consumed authority receipt`);
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

export function normalizeCodexResult(stdout: string): NormalizedCodexBaseResult;
export function normalizeCodexResult(
  stdout: string,
  options: { includeUsage: true },
): NormalizedCodexResult;
export function normalizeCodexResult(
  stdout: string,
  options: CodexEvalNormalizationOptions,
): NormalizedCodexEvalResult;
export function normalizeCodexResult(
  stdout: string,
  options?: { includeUsage?: boolean } | CodexEvalNormalizationOptions,
): NormalizedCodexBaseResult | NormalizedCodexResult | NormalizedCodexEvalResult {
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
  const current = records.some((item) => item.type === "thread.started");
  const texts: string[] = [];
  let usageSource: Record<string, unknown> | null = null;
  let providerSessionId: string;
  if (current) {
    if (records[0]?.type !== "thread.started" ||
        records.filter((item) => item.type === "thread.started").length !== 1) {
      throw new Error("incomplete Codex stream: invalid thread identity");
    }
    if (typeof records[0].thread_id !== "string" || !records[0].thread_id.trim()) {
      throw new Error("incomplete Codex stream: invalid thread identity");
    }
    providerSessionId = records[0].thread_id;
    let completed = false;
    for (const event of records.slice(1)) {
      if (completed) {
        throw new Error("invalid Codex stream ordering: event after terminal");
      }
      if (event.type === "turn.failed" || event.type === "error") {
        throw new Error("Codex stream terminal failure");
      }
      if (event.type === "item.completed") {
        const item = record(event.item);
        if (item?.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
      }
      if (event.type === "turn.completed") {
        if (!texts.length) throw new Error("invalid Codex stream ordering: terminal before result");
        completed = true;
        usageSource = record(event.usage);
      }
    }
    if (!completed) throw new Error("incomplete Codex stream: missing terminal");
  } else {
    const sessions = records
      .filter((item) => item.type === "session_meta")
      .map((item) => record(item.payload));
    if (sessions.length !== 1 || sessions[0]?.model !== MODEL) {
      throw new Error(`model identity mismatch: ${String(sessions[0]?.model)}`);
    }
    if (typeof sessions[0].id !== "string" || !sessions[0].id.trim()) {
      throw new Error("incomplete Codex stream: invalid session identity");
    }
    providerSessionId = sessions[0].id;
    for (const event of records) {
      if (event.type === "response_item") {
        const payload = record(event.payload);
        if (payload?.type !== "message" || payload.role !== "assistant" || !Array.isArray(payload.content)) continue;
        for (const rawPart of payload.content) {
          const part = record(rawPart);
          if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
        }
      }
      if (event.type === "event_msg") {
        const payload = record(event.payload);
        if (payload?.type !== "token_count") continue;
        const info = record(payload.info);
        usageSource = record(info?.last_token_usage);
      }
    }
  }
  if (!texts.length) throw new Error("incomplete Codex stream: missing result");
  // Codex can emit progress or policy-required announcements as completed
  // assistant messages. The final completed message is the terminal response;
  // composing messages would corrupt strict JSON result contracts.
  let text = texts.at(-1)!;
  if (options && "expectedProtocolVersion" in options) {
    if (options.pinnedModel !== MODEL) throw new Error("Codex command-pinned model mismatch");
    // Structured Codex runs may emit schema-valid progress messages before the
    // terminal schema-valid message. Only the last completed agent message is
    // the final response contract; joining them creates invalid JSON.
    let payload: Record<string, unknown> | null;
    try { payload = record(JSON.parse(text)); }
    catch { throw new Error("malformed Codex visible result parse"); }
    if (!payload || payload.protocolVersion !== options.expectedProtocolVersion) {
      throw new Error("Codex protocol mismatch");
    }
    if (payload.reasoningEffort !== options.expectedEffort) {
      throw new Error("Codex reasoning effort mismatch");
    }
    if (typeof payload.visibleText !== "string" || !payload.visibleText.trim()) {
      throw new Error("incomplete Codex result: missing visible text");
    }
    text = payload.visibleText;
    return withProviderSessionRef({
      text,
      model: MODEL,
      modelProvenance: "command_pinned",
      effort: options.expectedEffort,
      protocolVersion: options.expectedProtocolVersion,
      usage: usageTelemetry(usageSource),
    }, providerSessionId);
  }
  const base: NormalizedCodexBaseResult = { text, model: MODEL };
  return options?.includeUsage
    ? withProviderSessionRef({ ...base, usage: usageTelemetry(usageSource) }, providerSessionId)
    : base;
}

function withProviderSessionRef<T extends object>(value: T, sessionId: string): T & {
  readonly providerSessionRef: ProviderSessionRef;
} {
  Object.defineProperty(value, "providerSessionRef", {
    value: Object.freeze({ value: sessionId, provenance: "provider_reported" as const }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value as T & { readonly providerSessionRef: ProviderSessionRef };
}
