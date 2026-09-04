import { createHash } from "node:crypto";
import { canonicalJson, validateJsonValue, type GraphNode } from "../workflow/flow-contract.js";
import { isUsageCompleteness, type UsageCompleteness } from "./flow-telemetry.js";

export type { UsageCompleteness } from "./flow-telemetry.js";

export interface NodeUsage {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costMicroUsd?: number | null;
  readonly completeness: UsageCompleteness;
}

export interface NodeResultInput {
  readonly schemaVersion: "NodeResult/v1";
  readonly nodeId: string;
  readonly outcome: "success" | "failure" | "cancelled";
  readonly output?: unknown;
  readonly usage?: NodeUsage;
  readonly [key: string]: unknown;
}

export interface ValidatedNodeResult extends NodeResultInput {
  readonly outputHash?: string;
}

export function validateNodeResult(node: GraphNode, input: unknown): ValidatedNodeResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("NodeResult must be an object");
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "flowId", "nodeId", "workflowId", "runId", "attemptId", "sessionId",
    "resultSchemaHash", "validatorVersion", "output", "outputHash", "route",
    "executionSnapshotHash", "sourceFingerprint", "usage", "outcome", "startedAt", "terminalAt",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`NodeResult contains unknown field ${unknown}`);
  if (value.schemaVersion !== "NodeResult/v1") throw new Error("unsupported NodeResult schemaVersion");
  if (value.nodeId !== node.id) throw new Error("NodeResult node identity mismatch");
  if (!["success", "failure", "cancelled"].includes(String(value.outcome))) throw new Error("NodeResult outcome is invalid");
  validateUsage(value.usage);
  if (value.outcome === "success") {
    if (!("output" in value)) throw new Error("successful NodeResult requires output");
    validateJsonValue(node.outputSchema, value.output);
    const output = structuredClone(value.output);
    const outputHash = createHash("sha256").update(canonicalJson(output)).digest("hex");
    if (value.outputHash !== undefined && value.outputHash !== outputHash) throw new Error("NodeResult output hash mismatch");
    const outputRoute = output !== null && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>).route ?? null
      : null;
    if (value.route !== undefined && value.route !== outputRoute) throw new Error("NodeResult route does not match typed output");
    return Object.freeze({
      ...(structuredClone(value) as NodeResultInput),
      output,
      outputHash,
    });
  }
  if (value.output !== undefined) throw new Error("non-success NodeResult cannot carry typed output");
  return Object.freeze(structuredClone(value) as NodeResultInput);
}

function validateUsage(input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("NodeResult usage is required");
  const usage = input as Record<string, unknown>;
  const unknown = Object.keys(usage).find((key) => !["inputTokens", "outputTokens", "costMicroUsd", "completeness", "provenance"].includes(key));
  if (unknown) throw new Error(`usage contains unknown field ${unknown}`);
  if (!isUsageCompleteness(usage.completeness)) throw new Error("usage completeness is invalid");
  for (const key of ["inputTokens", "outputTokens", "costMicroUsd"] as const) {
    const amount = usage[key];
    if (amount !== undefined && amount !== null && (!Number.isInteger(amount) || (amount as number) < 0)) throw new Error(`usage.${key} is invalid`);
  }
}
