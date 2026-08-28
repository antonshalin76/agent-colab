import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Effort } from "../domain/routing.js";
import type { CommandSpec } from "./provider-command.js";

export type GrokEffort = "low" | "medium" | "high" | "xhigh";
export type GrokApprovalScope = "workspace-read";

export interface GrokCommandInput {
  binary: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  approvalScope: GrokApprovalScope;
  effort: GrokEffort;
  timeoutMs: number;
}

export interface NormalizedGrokResult {
  text: string;
  model: "grok-4.6";
  providerReportedModel: "grok-4.6" | "grok-4.6-build";
  modelProvenance: "provider_reported_alias";
  effort: GrokEffort;
  protocolVersion: string;
}
export interface NormalizedGrokEvalResult extends NormalizedGrokResult {
  visibleTextProvenance: "provider_structured" | "command_pinned_plain_text";
  usage: GrokUsageTelemetry;
}

interface GrokUsageTelemetry {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  provenance: Record<
    "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens" | "costUsd",
    "provider_reported" | "unavailable"
  >;
}

const DEFAULT_GROK_BINARY = join(homedir(), ".local", "bin", "grok");
const MODEL = "grok-4.6";
const REPORTED_MODEL_IDS = new Set([MODEL, "grok-4.6-build"]);
const READ_TOOLS = ["read_file", "grep", "list_dir"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESULT_BYTES = 1024 * 1024;
const EXECUTABLE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function reportedNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function usageTelemetry(
  source: Record<string, unknown>,
  summary: Record<string, unknown> | null,
  envelope: Record<string, unknown>,
): GrokUsageTelemetry {
  const values = {
    inputTokens: reportedNumber(source.inputTokens, summary?.input_tokens),
    cachedInputTokens: reportedNumber(
      source.cacheReadInputTokens,
      source.cachedInputTokens,
      summary?.cache_read_input_tokens,
    ),
    outputTokens: reportedNumber(source.outputTokens, summary?.output_tokens),
    reasoningTokens: reportedNumber(
      source.reasoningTokens,
      source.reasoningOutputTokens,
      summary?.reasoning_tokens,
    ),
    totalTokens: reportedNumber(source.totalTokens, summary?.total_tokens),
    costUsd: reportedNumber(source.costUSD, source.costUsd, envelope.total_cost_usd),
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

export function buildGrokCommand(input: GrokCommandInput): CommandSpec {
  const untrusted = input as GrokCommandInput & Record<string, unknown>;
  if (
    input.approvalScope !== "workspace-read" ||
    Object.hasOwn(untrusted, "approvalReference") ||
    Object.hasOwn(untrusted, "toolAllowlist")
  ) {
    throw new Error("Grok command authority is fixed to workspace-read");
  }
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
  args.push(
    "--sandbox",
    "strict",
    "--permission-mode",
    "dontAsk",
    "--tools",
    READ_TOOLS.join(","),
  );
  const promptFileArgIndex = args.indexOf("/dev/stdin");
  return {
    file: input.binary,
    args,
    cwd: input.cwd,
    stdin: input.prompt,
    shell: false,
    timeoutMs: input.timeoutMs,
    killProcessGroup: true,
    promptFileArgIndex,
  };
}

export function normalizeGrokResult(
  stdout: string,
  expected: {
    expectedEffort: Effort;
    expectedProtocolVersion: string;
    includeUsage: true;
    allowPlainVisibleText?: boolean;
  },
): NormalizedGrokEvalResult;
export function normalizeGrokResult(
  stdout: string,
  expected: {
    expectedEffort: Effort;
    expectedProtocolVersion: string;
    includeUsage?: false;
    allowPlainVisibleText?: boolean;
  },
): NormalizedGrokResult;
export function normalizeGrokResult(
  stdout: string,
  expected: {
    expectedEffort: Effort;
    expectedProtocolVersion: string;
    includeUsage?: boolean;
    allowPlainVisibleText?: boolean;
  },
): NormalizedGrokResult | NormalizedGrokEvalResult {
  if (!EXECUTABLE_EFFORTS.has(expected.expectedEffort)) {
    throw new Error("Grok result expected effort exceeds provider capability");
  }
  const expectedEffort = expected.expectedEffort as GrokEffort;
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
  const reportedModels = usage ? Object.keys(usage) : [];
  const providerReportedModel = reportedModels[0];
  const modelUsage = usage && providerReportedModel ? record(usage[providerReportedModel]) : null;
  if (!usage || reportedModels.length !== 1 || !providerReportedModel
      || !REPORTED_MODEL_IDS.has(providerReportedModel) || !modelUsage) {
    throw new Error("model identity mismatch: expected grok-4.6 modelUsage");
  }
  let payload = record(envelope.structuredOutput);
  let visibleTextProvenance: NormalizedGrokEvalResult["visibleTextProvenance"] =
    "provider_structured";
  if (payload === null) {
    try { payload = record(JSON.parse(envelope.text)); } catch { payload = null; }
  }
  const hasTransportDiscriminant = payload !== null && (
    "protocolVersion" in payload || "reasoningEffort" in payload || "visibleText" in payload
  );
  if (!hasTransportDiscriminant && expected.allowPlainVisibleText) {
    if (!envelope.text.trim()) throw new Error("malformed Grok visible result parse");
    payload = {
      protocolVersion: expected.expectedProtocolVersion,
      reasoningEffort: expectedEffort,
      visibleText: envelope.text,
    };
    visibleTextProvenance = "command_pinned_plain_text";
  } else if (payload === null) {
    throw new Error("malformed Grok visible result parse");
  }
  if (!payload || payload.protocolVersion !== expected.expectedProtocolVersion) {
    throw new Error("Grok protocol mismatch");
  }
  if (payload.reasoningEffort !== expectedEffort) {
    throw new Error("Grok reasoning effort mismatch");
  }
  if (typeof payload.visibleText !== "string" || !payload.visibleText.trim()) {
    throw new Error("incomplete Grok result: missing visible text");
  }
  const base: NormalizedGrokResult = {
    text: payload.visibleText,
    model: MODEL,
    providerReportedModel: providerReportedModel as "grok-4.6" | "grok-4.6-build",
    modelProvenance: "provider_reported_alias",
    effort: expectedEffort,
    protocolVersion: expected.expectedProtocolVersion,
  };
  return expected.includeUsage
    ? {
      ...base,
      visibleTextProvenance,
      usage: usageTelemetry(modelUsage, record(envelope.usage), envelope),
    }
    : base;
}
