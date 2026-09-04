import {
  normalizeProviderUsage,
  type NormalizedProviderUsage,
  type UsageTelemetry,
} from "./flow-telemetry.js";
import {
  assertProviderSessionIdentity,
  assertTelemetryProvider,
  TELEMETRY_PROVIDERS,
  type TelemetryProvider,
} from "./flow-telemetry-identity.js";

export { TELEMETRY_PROVIDERS, type TelemetryProvider } from "./flow-telemetry-identity.js";
export type ProviderSessionProvenance = "command_pinned" | "provider_reported";
export type ProviderTelemetryOutcome =
  | "succeeded"
  | "provider_failure"
  | "timeout"
  | "malformed_terminal"
  | "pre_session_failure";

export interface ProviderSessionRef {
  readonly value: string;
  readonly provenance: ProviderSessionProvenance;
}

export interface ProviderTerminalTelemetry {
  readonly schemaVersion: "ProviderTerminalTelemetry/v1";
  readonly provider: TelemetryProvider;
  readonly providerSessionRef: ProviderSessionRef | null;
  readonly outcome: ProviderTelemetryOutcome;
  readonly usage: NormalizedProviderUsage;
}

const quarantinedObservations = new WeakMap<object, ProviderTerminalTelemetry>();

export function carryQuarantinedProviderTelemetry<T extends object>(
  result: T,
  observation: ProviderTerminalTelemetry,
): T {
  if (quarantinedObservations.has(result)) {
    throw new Error("provider telemetry result already carries a quarantined observation");
  }
  quarantinedObservations.set(result, observation);
  return result;
}

export function readQuarantinedProviderTelemetry(
  result: unknown,
): ProviderTerminalTelemetry | null {
  return typeof result === "object" && result !== null
    ? quarantinedObservations.get(result) ?? null
    : null;
}

export function mapProviderTelemetryOutcome(input: {
  readonly provider: TelemetryProvider;
  readonly providerSessionRef: ProviderSessionRef | null;
  readonly outcome: "success" | Exclude<ProviderTelemetryOutcome, "succeeded">;
  readonly usageReport: UsageTelemetry | null | unknown;
}): ProviderTerminalTelemetry {
  assertTelemetryProvider(input.provider, "provider telemetry identity");
  const providerSessionRef = validateProviderSessionRef(input.providerSessionRef);
  if (input.outcome === "pre_session_failure" && providerSessionRef !== null) {
    throw new Error("pre-session failure cannot contain a provider session identity");
  }
  if (input.outcome === "success" && providerSessionRef === null) {
    throw new Error("successful provider telemetry requires a provider session identity");
  }
  const outcome = input.outcome === "success" ? "succeeded" : input.outcome;
  if (!["succeeded", "provider_failure", "timeout", "malformed_terminal", "pre_session_failure"]
    .includes(outcome)) {
    throw new Error("provider telemetry outcome is invalid");
  }
  const usage = outcome === "succeeded"
    ? normalizeProviderUsage({ provider: input.provider, usage: input.usageReport })
    : normalizeProviderUsage({ provider: input.provider, usage: null });
  return deepFreeze({
    schemaVersion: "ProviderTerminalTelemetry/v1",
    provider: input.provider,
    providerSessionRef,
    outcome,
    usage,
  });
}

function validateProviderSessionRef(input: ProviderSessionRef | null): ProviderSessionRef | null {
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 2 || !Object.hasOwn(input, "value") ||
      !Object.hasOwn(input, "provenance")) {
    throw new Error("provider session identity has an invalid field set");
  }
  const value = assertProviderSessionIdentity(input.value, "provider session identity");
  if (input.provenance !== "command_pinned" && input.provenance !== "provider_reported") {
    throw new Error("provider session identity is invalid");
  }
  return Object.freeze({ value, provenance: input.provenance });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
