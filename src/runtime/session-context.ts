import { createHash } from "node:crypto";
import { canonicalJson } from "../workflow/flow-contract.js";

const MAX_CHECKPOINT_BYTES = 256 * 1024;
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[-_]?key|credential)/i;

export interface SessionCheckpointBody {
  readonly objective: string;
  readonly activePlanRef?: string;
  readonly instructionRefs?: readonly string[];
  readonly artifactRefs?: readonly string[];
  readonly predecessorResultRefs?: readonly string[];
  readonly openIssues?: readonly string[];
  readonly nextAction?: string;
  readonly compactionReason?: string;
  readonly replacedRevisionHashes?: readonly string[];
}

export interface SessionCheckpoint {
  readonly schemaVersion: "SessionCheckpoint/v1";
  readonly project: string;
  readonly flowId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly previousRevisionHash: string | null;
  readonly body: SessionCheckpointBody;
  readonly checkpointHash: string;
}

export function createSessionCheckpoint(input: {
  readonly project: string;
  readonly flowId: string;
  readonly sessionId: string;
  readonly body: SessionCheckpointBody;
  readonly previous?: SessionCheckpoint;
}): SessionCheckpoint {
  boundedIdentity(input.project, "project", 4096);
  boundedIdentity(input.flowId, "flowId", 128);
  boundedIdentity(input.sessionId, "sessionId", 128);
  rejectSensitiveKeys(input.body);
  if (input.previous) {
    assertSessionIsolation(input.flowId, input.previous);
    if (input.previous.project !== input.project || input.previous.sessionId !== input.sessionId) throw new Error("checkpoint chain scope mismatch");
    verifySessionCheckpoint(input.previous);
  }
  const unsigned = {
    schemaVersion: "SessionCheckpoint/v1" as const,
    project: input.project,
    flowId: input.flowId,
    sessionId: input.sessionId,
    revision: (input.previous?.revision ?? -1) + 1,
    previousRevisionHash: input.previous?.checkpointHash ?? null,
    body: structuredClone(input.body),
  };
  const bytes = Buffer.byteLength(canonicalJson(unsigned));
  if (bytes > MAX_CHECKPOINT_BYTES) throw new Error("session checkpoint exceeds 256 KiB");
  return deepFreeze({ ...unsigned, checkpointHash: digest(unsigned) });
}

export function verifySessionCheckpoint(checkpoint: SessionCheckpoint, previous?: SessionCheckpoint): void {
  const { checkpointHash, ...unsigned } = checkpoint;
  if (digest(unsigned) !== checkpointHash) throw new Error("session checkpoint hash mismatch");
  if (Buffer.byteLength(canonicalJson(unsigned)) > MAX_CHECKPOINT_BYTES) throw new Error("session checkpoint exceeds 256 KiB");
  rejectSensitiveKeys(checkpoint.body);
  if (previous) {
    if (checkpoint.project !== previous.project || checkpoint.flowId !== previous.flowId || checkpoint.sessionId !== previous.sessionId) throw new Error("checkpoint chain scope mismatch");
    if (checkpoint.revision !== previous.revision + 1 || checkpoint.previousRevisionHash !== previous.checkpointHash) throw new Error("checkpoint hash chain mismatch");
  } else if (checkpoint.revision !== 0 || checkpoint.previousRevisionHash !== null) {
    throw new Error("a checkpoint without its predecessor must be the initial revision");
  }
}

export function assertSessionIsolation(expectedFlowId: string, context: { readonly flowId: string; readonly sessionId: string }): void {
  if (context.flowId !== expectedFlowId) throw new Error("cross-flow session context rejected");
  boundedIdentity(context.sessionId, "sessionId", 128);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function rejectSensitiveKeys(value: unknown, path = "body"): void {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitiveKeys(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${path}.${key} may contain a secret`);
    rejectSensitiveKeys(child, `${path}.${key}`);
  }
}

function boundedIdentity(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${label} must be a bounded non-empty string`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
