import { z } from "zod";

import { redactSensitive } from "../security/redaction.js";

export const TELEMETRY_PROVIDERS = ["codex", "grok", "claude"] as const;
export type TelemetryProvider = (typeof TELEMETRY_PROVIDERS)[number];

export const TELEMETRY_SESSION_KINDS = ["node_attempt", "coordination"] as const;
export type TelemetrySessionKind = (typeof TELEMETRY_SESSION_KINDS)[number];

export type TelemetryStableIdField =
  | "flowId"
  | "eventId"
  | "nodeId"
  | "attemptId"
  | "sessionId"
  | "parentSessionId"
  | "usageId"
  | "receiptId"
  | "requestId";

export type TelemetryStringPolicyField =
  | TelemetryStableIdField
  | "provider"
  | "providerSessionId"
  | "providerSessionRef.value"
  | "sessionKind"
  | "eventType"
  | "eventVersion"
  | "traceId"
  | "spanId";

const STABLE_ID = /^[A-Za-z0-9._:-]+$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]*$/;
const EVENT_VERSION = /^[A-Za-z0-9._-]+$/;
const TRACE_ID = /^[a-f0-9]{32}$/;
const SPAN_ID = /^[a-f0-9]{16}$/;
const PROVIDER_SESSION_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const unknownString = z.string();

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stringValue(value: unknown, label: string): string {
  const parsed = unknownString.safeParse(value);
  if (!parsed.success) throw new Error(`${label} identity must be a string`);
  return parsed.data;
}

function rejectSensitive(value: string, label: string): void {
  if (redactSensitive(value) !== value) {
    throw new Error(`${label} contains a sensitive value and cannot be persisted as telemetry identity`);
  }
}

export function assertTelemetryStableId(
  value: unknown,
  field: TelemetryStableIdField,
  label: string = field,
): string {
  const parsed = stringValue(value, label);
  const bytes = byteLength(parsed);
  if (bytes < 1 || bytes > 128 || !STABLE_ID.test(parsed)) {
    throw new Error(`${label} identity must be safe ASCII with UTF-8 length 1..128`);
  }
  rejectSensitive(parsed, label);
  return parsed;
}

export function assertNullableTelemetryStableId(
  value: unknown,
  field: TelemetryStableIdField,
  label: string = field,
): string | null {
  return value === null ? null : assertTelemetryStableId(value, field, label);
}

export function assertTelemetryProvider(value: unknown, label = "provider"): TelemetryProvider {
  const parsed = stringValue(value, label);
  if (!(TELEMETRY_PROVIDERS as readonly string[]).includes(parsed)) {
    throw new Error(`${label} identity must be exactly codex, grok, or claude`);
  }
  return parsed as TelemetryProvider;
}

export function assertProviderSessionIdentity(value: unknown, label = "provider session identity"): string {
  const parsed = stringValue(value, label);
  const bytes = byteLength(parsed);
  if (bytes < 1 || bytes > 256 || PROVIDER_SESSION_FORBIDDEN.test(parsed)) {
    throw new Error(`${label} must be printable Unicode with UTF-8 length 1..256 and no control or bidi characters`);
  }
  rejectSensitive(parsed, label);
  return parsed;
}

export function assertTelemetrySessionKind(value: unknown, label = "session kind"): TelemetrySessionKind {
  const parsed = stringValue(value, label);
  if (!(TELEMETRY_SESSION_KINDS as readonly string[]).includes(parsed)) {
    throw new Error(`${label} must be exactly node_attempt or coordination`);
  }
  return parsed as TelemetrySessionKind;
}

export function assertTelemetryEventType(value: unknown, label = "eventType"): string {
  const parsed = stringValue(value, label);
  const bytes = byteLength(parsed);
  if (bytes < 1 || bytes > 64 || !EVENT_TYPE.test(parsed)) {
    throw new Error(`${label} must start with lowercase ASCII and contain only lowercase ASCII, digits, or underscore with length 1..64`);
  }
  rejectSensitive(parsed, label);
  return parsed;
}

export function assertTelemetryEventVersion(value: unknown, label = "eventVersion"): string {
  const parsed = stringValue(value, label);
  const bytes = byteLength(parsed);
  if (bytes < 1 || bytes > 32 || !EVENT_VERSION.test(parsed)) {
    throw new Error(`${label} must be safe ASCII with UTF-8 length 1..32`);
  }
  rejectSensitive(parsed, label);
  return parsed;
}

export function assertTelemetryTraceId(value: unknown, label = "traceId"): string {
  const parsed = stringValue(value, label);
  if (!TRACE_ID.test(parsed) || /^0+$/.test(parsed)) {
    throw new Error(`${label} must be exactly 32 lowercase hexadecimal characters and not all zero`);
  }
  return parsed;
}

export function assertTelemetrySpanId(value: unknown, label = "spanId"): string {
  const parsed = stringValue(value, label);
  if (!SPAN_ID.test(parsed) || /^0+$/.test(parsed)) {
    throw new Error(`${label} must be exactly 16 lowercase hexadecimal characters and not all zero`);
  }
  return parsed;
}

export function assertTelemetryIdentitySafe(value: unknown, label: string): string {
  return assertTelemetryStableId(value, "eventId", label);
}
