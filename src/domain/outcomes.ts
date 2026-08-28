import type { ProviderHealth, ReviewProviderId } from "./routing.js";

export const FAILOVER_OUTCOMES = [
  "quota",
  "rate_limit",
  "overload",
  "network_timeout",
  "model_unavailable",
  "cli_missing",
  "auth",
] as const;

export const TERMINAL_OUTCOMES = [
  "task_failure",
  "invalid_request",
  "safety_denial",
  "permission_denial",
  "user_cancelled",
] as const;

export type OutcomeKind = (typeof FAILOVER_OUTCOMES)[number] | (typeof TERMINAL_OUTCOMES)[number];
export type FailoverOutcomeKind = (typeof FAILOVER_OUTCOMES)[number];
export interface ProviderOutcome {
  kind: OutcomeKind;
  retryAt?: number;
}

export const MAX_PROVIDER_RESET_HORIZON_MS = 31 * 24 * 60 * 60 * 1_000;
const DEFAULT_PROVIDER_RESET_OFFSET = "+08:00";

export function parseProviderRetryAt(text: string, now = Date.now()): number | undefined {
  const values: number[] = [];
  const accept = (value: number): void => {
    if (Number.isSafeInteger(value) && value > now && value < now + MAX_PROVIDER_RESET_HORIZON_MS) values.push(value);
  };
  for (const match of text.matchAll(/retry-after\s*:\s*(\d+)/gi)) accept(now + Number(match[1]) * 1_000);
  for (const match of text.matchAll(/(?:reset(?:s|\s+at)?|retry(?:\s+at)?|until)\D{0,24}(\d{10}|\d{13}|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/gi)) {
    const raw = match[1];
    if (!raw) continue;
    const value = /^\d{10}$/.test(raw) ? Number(raw) * 1_000
      : /^\d{13}$/.test(raw) ? Number(raw)
        : new Date(`${raw.includes("T") ? raw : raw.replace(" ", "T")}${/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? "" : DEFAULT_PROVIDER_RESET_OFFSET}`).getTime();
    accept(value);
  }
  return values.length ? Math.max(...values) : undefined;
}

export class ProviderTransportFailure extends Error {
  constructor(
    message: string,
    readonly outcome: OutcomeKind = "task_failure",
  ) {
    super(message);
    this.name = "ProviderTransportFailure";
  }
}

export function classifyProviderFailureDetail(error: unknown, stderr = "", now = Date.now()): ProviderOutcome {
  if (error instanceof ProviderTransportFailure) return { kind: error.outcome };
  const message = `${error instanceof Error ? error.message : String(error)} ${stderr}`.toLowerCase();
  const retryAt = parseProviderRetryAt(`${error instanceof Error ? error.message : String(error)} ${stderr}`, now);
  if (/rate.?limit|429/.test(message)) return { kind: "rate_limit", ...(retryAt ? { retryAt } : {}) };
  if (/quota|usage limit/.test(message)) return { kind: "quota", ...(retryAt ? { retryAt } : {}) };
  if (/unrecognized_model|unsupported model|model not found/.test(message)) return { kind: "task_failure" };
  if (/model (?:is )?unavailable/.test(message)) return { kind: "model_unavailable" };
  if (/enoent|command not found|no such file or directory/.test(message)) return { kind: "cli_missing" };
  if (/timed?\s*out|timeout/.test(message)) return { kind: "network_timeout" };
  if (/auth|login|not logged|credential/.test(message)) return { kind: "auth" };
  if (/model identity mismatch|protocol mismatch|reasoning effort mismatch|malformed .* visible result parse/.test(message)) {
    return { kind: "task_failure" };
  }
  if (/overload|unavailable|capacity|malformed .* (?:stream|parse)|incomplete .* (?:stream|result)|nonterminal/.test(message)) {
    return { kind: "model_unavailable" };
  }
  if (/permission|denied/.test(message)) return { kind: "permission_denial" };
  if (/invalid request|bad request/.test(message)) return { kind: "invalid_request" };
  return { kind: "task_failure" };
}

export function classifyProviderFailure(error: unknown, stderr = ""): OutcomeKind {
  return classifyProviderFailureDetail(error, stderr).kind;
}

const FAILOVER_SET: ReadonlySet<string> = new Set(FAILOVER_OUTCOMES);
const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_OUTCOMES);

export const isFailoverOutcome = (kind: unknown): kind is FailoverOutcomeKind =>
  typeof kind === "string" && FAILOVER_SET.has(kind);

export function classifyOutcome(outcome: ProviderOutcome) {
  if (isFailoverOutcome(outcome.kind)) {
    return { failoverEligible: true, countsAgainstProvider: true } as const;
  }
  if (TERMINAL_SET.has(outcome.kind)) {
    return { failoverEligible: false, countsAgainstProvider: false } as const;
  }
  throw new Error(`Unknown outcome: ${String(outcome.kind)}`);
}

export interface StartupProbeExpected {
  binaryPath: string;
  version: string;
  model: string;
  protocolVersion: string;
}
export interface ParsedProbe {
  protocolVersion: string;
  supportsNonInteractive: boolean;
  supportsResume: boolean;
}
export interface StartupProbeObserved {
  binaryPath: string;
  version: string;
  authenticated: boolean;
  model: string;
  parsed: ParsedProbe | null;
}
export interface StartupProbeResult {
  health: ProviderHealth;
  ready: boolean;
  failures: string[];
}

export function evaluateStartupProbe(input: {
  agent: ReviewProviderId;
  enabled: boolean;
  expected: StartupProbeExpected;
  observed: StartupProbeObserved | null;
}): StartupProbeResult {
  if (!input.enabled) {
    return { health: "disabled", ready: false, failures: ["provider_disabled"] };
  }
  const failures: string[] = [];
  const observed = input.observed;
  if (observed === null) {
    failures.push("response_parse_failed");
  } else {
    if (observed.binaryPath !== input.expected.binaryPath) failures.push("binary_path_mismatch");
    if (observed.version !== input.expected.version) failures.push("version_mismatch");
    if (!observed.authenticated) failures.push("authentication_failed");
    if (observed.model !== input.expected.model) failures.push("model_mismatch");
    if (observed.parsed === null) {
      failures.push("response_parse_failed");
    } else {
      if (observed.parsed.protocolVersion !== input.expected.protocolVersion) {
        failures.push("protocol_mismatch");
      }
      if (!observed.parsed.supportsNonInteractive) failures.push("non_interactive_unsupported");
      if (!observed.parsed.supportsResume) failures.push("resume_unsupported");
    }
  }
  return failures.length === 0
    ? { health: "healthy", ready: true, failures }
    : { health: "unavailable", ready: false, failures };
}
