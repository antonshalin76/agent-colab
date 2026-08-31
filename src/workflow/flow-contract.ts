import { createHash } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import canonicalize from "canonicalize";
import { buildFlowGraph, graphDepth, type FlowGraphIndex } from "./flow-graph.js";

export type JoinPolicy = "all_success" | "all_terminal";
export type CanonicalNodeOutcome = "succeeded" | "failed" | "cancelled" | "skipped" | "blocked";
/** Includes legacy reducer spellings until its scheduled runtime cutover. */
export type NodeOutcome = CanonicalNodeOutcome | "success" | "failure";
export type StageKind = "coordination" | "architecture" | "implementation" | "testing" | "review" | "research" | "transform";
export const NODE_RESULT_VALIDATOR_VERSION = "ajv-8.20.0-draft-2020-12" as const;
export interface JsonSchema { readonly [key: string]: unknown }
export interface InputPort { readonly name: string; readonly schemaSha256: string; readonly required?: boolean }
export interface GraphNode {
  readonly nodeId: string; readonly stageKind: StageKind; readonly role: string;
  readonly approvalScope: string; readonly resourceHint?: string;
  readonly promptTemplateRef: string; readonly artifactRef: string;
  readonly inputPorts: readonly InputPort[]; readonly outputSchema: JsonSchema;
  readonly joinPolicy: JoinPolicy; readonly allowedRoutes: readonly string[];
  readonly timeoutMs: number; readonly maxAttempts: number; readonly requestedTokenLimit: number;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly id: string;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly kind: string;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly inputSchema: JsonSchema;
}
export interface OutcomeCondition {
  readonly kind: "outcome"; readonly outcomes: readonly CanonicalNodeOutcome[];
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly outcome?: NodeOutcome;
  readonly route?: never;
}
export interface RouteCondition {
  readonly kind: "route"; readonly routes: readonly string[];
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly route?: string;
  readonly outcome?: never;
}
export type GraphEdgeCondition = OutcomeCondition | RouteCondition;
export interface GraphEdge {
  readonly edgeId: string; readonly sourceId: string; readonly targetId: string;
  readonly condition: GraphEdgeCondition;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly id: string;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly from: string;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly to: string;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly join: JoinPolicy;
}
export interface GraphBudget {
  readonly maxNodes: number; readonly maxActiveReadOnly: number; readonly maxChildDepth: number;
  readonly maxTokens: number; readonly maxWallTimeMs: number; readonly maxCostMicrousd?: number;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly maxActiveReadOnlyNodes: number;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly maxDepth: number;
  /** @deprecated compatibility accessor until the scheduled runtime cutover. */ readonly maxCostUsd?: number;
}
export interface GraphFlow {
  readonly schemaVersion: "GraphFlow/v1"; readonly flowId: string; readonly taskId: string;
  readonly project: string; readonly origin: string; readonly definitionSha256: string;
  readonly budget: GraphBudget; readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[];
}
export interface ValidatedGraphFlow { readonly graph: GraphFlow; readonly index: FlowGraphIndex }
export interface NodeResultV1 {
  readonly schemaVersion: "NodeResult/v1"; readonly flowId: string; readonly nodeId: string;
  readonly workflowId: string; readonly runId: string; readonly attemptId: string; readonly sessionId: string;
  readonly resultSchemaSha256: string; readonly validatorVersion: string; readonly output: unknown;
  readonly outputSha256: string; readonly route: string | null; readonly executionSnapshotSha256: string;
  readonly sourceFingerprint: string; readonly usage: {
    readonly provenance: string; readonly completeness: "exact" | "partial" | "unavailable";
    readonly inputTokens: number | null; readonly outputTokens: number | null; readonly costMicrousd: number | null;
  };
  readonly outcome: "succeeded"; readonly startedAt: number; readonly terminalAt: number;
}
export interface NodeResultExpectation {
  readonly flowId: string; readonly workflowId: string; readonly runId: string;
  readonly attemptId: string; readonly sessionId: string; readonly validatorVersion: string;
  readonly executionSnapshotSha256: string; readonly sourceFingerprint: string;
}

const SHA256 = "^[a-f0-9]{64}$";
const ID = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" } as const;
const GRAPH_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "flowId", "taskId", "project", "origin", "definitionSha256", "budget", "nodes", "edges"],
  properties: {
    schemaVersion: { const: "GraphFlow/v1" }, flowId: ID, taskId: ID,
    project: { type: "string", minLength: 1, maxLength: 512 }, origin: ID,
    definitionSha256: { type: "string", pattern: SHA256 },
    budget: { type: "object", additionalProperties: false,
      required: ["maxNodes", "maxActiveReadOnly", "maxChildDepth", "maxTokens", "maxWallTimeMs"],
      properties: {
        maxNodes: { type: "integer", minimum: 1, maximum: 100 },
        maxActiveReadOnly: { type: "integer", minimum: 1, maximum: 3 },
        maxChildDepth: { type: "integer", minimum: 0, maximum: 8 },
        maxTokens: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        maxWallTimeMs: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        maxCostMicrousd: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      } },
    nodes: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/$defs/node" } },
    edges: { type: "array", maxItems: 400, items: { $ref: "#/$defs/edge" } },
  },
  $defs: {
    node: { type: "object", additionalProperties: false,
      required: ["nodeId", "stageKind", "role", "approvalScope", "promptTemplateRef", "artifactRef", "inputPorts", "outputSchema", "joinPolicy", "allowedRoutes", "timeoutMs", "maxAttempts", "requestedTokenLimit"],
      properties: {
        nodeId: ID, stageKind: { enum: ["coordination", "architecture", "implementation", "testing", "review", "research", "transform"] },
        role: { type: "string", minLength: 1, maxLength: 128 }, approvalScope: { type: "string", minLength: 1, maxLength: 128 },
        resourceHint: { type: "string", minLength: 1, maxLength: 1024 }, promptTemplateRef: { type: "string", minLength: 1, maxLength: 1024 },
        artifactRef: { type: "string", minLength: 1, maxLength: 1024 },
        inputPorts: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
          required: ["name", "schemaSha256"], properties: { name: ID, schemaSha256: { type: "string", pattern: SHA256 }, required: { type: "boolean" } } } },
        outputSchema: { type: "object" }, joinPolicy: { enum: ["all_success", "all_terminal"] },
        allowedRoutes: { type: "array", maxItems: 32, uniqueItems: true, items: ID },
        timeoutMs: { type: "integer", minimum: 1, maximum: 1_800_000 }, maxAttempts: { type: "integer", minimum: 1, maximum: 5 },
        requestedTokenLimit: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      allOf: [{ if: { properties: { stageKind: { not: { const: "transform" } } }, required: ["stageKind"] },
        then: { properties: { requestedTokenLimit: { type: "integer", minimum: 1 } } } }],
    },
    edge: { type: "object", additionalProperties: false, required: ["edgeId", "sourceId", "targetId", "condition"],
      properties: { edgeId: ID, sourceId: ID, targetId: ID, condition: { oneOf: [
        { type: "object", additionalProperties: false, required: ["kind", "outcomes"], properties: { kind: { const: "outcome" }, outcomes: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["succeeded", "failed", "cancelled", "skipped", "blocked"] } } } },
        { type: "object", additionalProperties: false, required: ["kind", "routes"], properties: { kind: { const: "route" }, routes: { type: "array", minItems: 1, uniqueItems: true, items: ID } } },
      ] } },
    },
  },
} as const;

const NODE_RESULT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "flowId", "nodeId", "workflowId", "runId", "attemptId", "sessionId", "resultSchemaSha256", "validatorVersion", "output", "outputSha256", "route", "executionSnapshotSha256", "sourceFingerprint", "usage", "outcome", "startedAt", "terminalAt"],
  properties: {
    schemaVersion: { const: "NodeResult/v1" }, flowId: ID, nodeId: ID, workflowId: ID, runId: ID, attemptId: ID, sessionId: ID,
    resultSchemaSha256: { type: "string", pattern: SHA256 }, validatorVersion: { type: "string", minLength: 1, maxLength: 128 },
    output: {}, outputSha256: { type: "string", pattern: SHA256 }, route: { anyOf: [ID, { type: "null" }] },
    executionSnapshotSha256: { type: "string", pattern: SHA256 }, sourceFingerprint: { type: "string", pattern: SHA256 },
    usage: { type: "object", additionalProperties: false, required: ["provenance", "completeness", "inputTokens", "outputTokens", "costMicrousd"],
      properties: { provenance: { type: "string", minLength: 1, maxLength: 1024 }, completeness: { enum: ["exact", "partial", "unavailable"] },
        inputTokens: { anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] },
        outputTokens: { anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] },
        costMicrousd: { anyOf: [{ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }] } } },
    outcome: { const: "succeeded" },
    startedAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    terminalAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const compiler = new Ajv2020({ strict: true, allErrors: true, validateSchema: true });
const outputCompiler = new Ajv2020({ strict: true, allErrors: true, validateSchema: true, addUsedSchema: false });
const graphValidator = compiler.compile(GRAPH_SCHEMA);
const nodeResultValidator = compiler.compile(NODE_RESULT_SCHEMA);

export function computeJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function computeGraphDefinitionSha256(input: unknown): string {
  const value = plainRecord(structuredClone(input), "graph definition");
  delete value.definitionSha256;
  return computeJsonSha256(value);
}

export function validateGraphFlow(input: unknown): ValidatedGraphFlow {
  assertJsonDocument(input);
  if (Buffer.byteLength(canonicalJson(input)) > 2 * 1024 * 1024) throw new Error("graph definition exceeds 2 MiB");
  if (!graphValidator(input)) throw new Error(`GraphFlow schema validation failed: ${compiler.errorsText(graphValidator.errors)}`);
  const graph = structuredClone(input) as GraphFlow;
  if (computeGraphDefinitionSha256(graph) !== graph.definitionSha256) throw new Error("GraphFlow definitionSha256 digest mismatch");
  for (const node of graph.nodes) {
    validateJsonSchema(node.outputSchema, `node ${node.nodeId} outputSchema`);
    unique(node.inputPorts.map((port) => port.name), `input port in node ${node.nodeId}`);
    const routeSchema = (node.outputSchema.properties as Record<string, unknown> | undefined)?.route as Record<string, unknown> | undefined;
    const routes = routeSchema?.enum;
    const routeLess = routes === undefined && node.allowedRoutes.length === 0;
    if (!routeLess && (!Array.isArray(routes) || routes.some((route) => typeof route !== "string") ||
        canonicalJson([...routes].sort()) !== canonicalJson([...node.allowedRoutes].sort()))) {
      throw new Error(`node ${node.nodeId} route declaration disagrees with output schema`);
    }
    if (node.timeoutMs > graph.budget.maxWallTimeMs) throw new Error(`node ${node.nodeId} timeout exceeds graph wall-time budget`);
    if (node.requestedTokenLimit > graph.budget.maxTokens) throw new Error(`node ${node.nodeId} token request exceeds graph token budget`);
  }
  unique(graph.nodes.map((node) => node.nodeId), "node id");
  unique(graph.edges.map((edge) => edge.edgeId), "edge id");
  unique(graph.edges.map((edge) => `${edge.sourceId}\0${edge.targetId}\0${canonicalConditionIdentity(edge.condition)}`), "edge identity");
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  for (const edge of graph.edges) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) throw new Error(`edge ${edge.edgeId} references an unknown node`);
    if (edge.sourceId === edge.targetId) throw new Error(`edge ${edge.edgeId} creates a self-cycle`);
    if (edge.condition.kind === "route" && edge.condition.routes.some((route) => !source.allowedRoutes.includes(route))) {
      throw new Error(`edge ${edge.edgeId} route is not declared by producer ${source.nodeId}`);
    }
  }
  attachCompatibilityAccessors(graph);
  const index = buildFlowGraph(graph);
  if (index.roots.length !== 1) throw new Error("graph must have exactly one root");
  const root = nodes.get(index.roots[0]!)!;
  if (root.stageKind !== "coordination") throw new Error("graph root must be a coordination node");
  const reachable = new Set<string>();
  const pending = [root.nodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    index.outgoing.get(nodeId)!.forEach((edge) => pending.push(edge.targetId));
  }
  if (reachable.size !== graph.nodes.length) throw new Error("every graph node must be reachable from the coordination root");
  if (graph.nodes.length > graph.budget.maxNodes) throw new Error("graph exceeds budget.maxNodes maximum nodes");
  if (graphDepth(index) > graph.budget.maxChildDepth) throw new Error("graph exceeds budget.maxChildDepth depth");
  return { graph: deepFreeze(graph), index };
}

export function validateNodeResultV1(node: GraphNode, input: unknown, expected: NodeResultExpectation): NodeResultV1 {
  assertJsonDocument(input);
  if (!nodeResultValidator(input)) throw new Error(`NodeResult schema validation failed: ${compiler.errorsText(nodeResultValidator.errors)}`);
  const result = structuredClone(input) as NodeResultV1;
  if (expected.validatorVersion !== NODE_RESULT_VALIDATOR_VERSION) throw new Error("NodeResult expected validatorVersion is not broker-owned");
  if (result.nodeId !== node.nodeId) throw new Error("NodeResult node identity mismatch");
  for (const key of ["flowId", "workflowId", "runId", "attemptId", "sessionId", "validatorVersion", "executionSnapshotSha256", "sourceFingerprint"] as const) {
    if (result[key] !== expected[key]) throw new Error(`NodeResult ${key} identity mismatch`);
  }
  if (result.resultSchemaSha256 !== computeJsonSha256(node.outputSchema)) throw new Error("NodeResult result schema digest mismatch");
  const usageValues = [result.usage.inputTokens, result.usage.outputTokens, result.usage.costMicrousd];
  const knownUsage = usageValues.filter((value) => value !== null).length;
  if ((result.usage.completeness === "exact" && knownUsage !== usageValues.length) ||
      (result.usage.completeness === "unavailable" && knownUsage !== 0) ||
      (result.usage.completeness === "partial" && knownUsage === 0)) {
    throw new Error("NodeResult usage values contradict completeness");
  }
  validateJsonValue(node.outputSchema, result.output);
  if (result.outputSha256 !== computeJsonSha256(result.output)) throw new Error("NodeResult output digest mismatch");
  const outputRoute = result.output !== null && typeof result.output === "object" && !Array.isArray(result.output)
    ? ((result.output as Record<string, unknown>).route ?? null) : null;
  if (result.route !== outputRoute || (result.route !== null && !node.allowedRoutes.includes(result.route))) {
    throw new Error("NodeResult route does not match typed output");
  }
  if (result.terminalAt < result.startedAt) throw new Error("NodeResult terminal timestamp precedes start timestamp");
  return deepFreeze(result);
}

export function validateJsonSchema(input: unknown, label = "schema"): JsonSchema {
  const schema = structuredClone(plainRecord(input, label));
  try { outputValidator(schema); } catch (error) {
    throw new Error(`${label} is not a strict JSON Schema 2020 document: ${error instanceof Error ? error.message : String(error)}`);
  }
  return deepFreeze(schema);
}

export function validateJsonValue(schema: JsonSchema, value: unknown): void {
  const validator = outputValidator(schema);
  if (!validator(value)) throw new Error(`JSON Schema validation failed: ${outputCompiler.errorsText(validator.errors)}`);
}

export function canonicalJson(value: unknown): string {
  assertJsonDocument(value);
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new Error("value cannot be RFC 8785 canonicalized");
  return encoded;
}

export function assertJsonDocument(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") { if (!Number.isFinite(candidate)) throw new Error("JSON document contains a non-finite number"); return; }
    if (typeof candidate !== "object") throw new Error("value is not a JSON document");
    if (ancestors.has(candidate)) throw new Error("JSON document contains a cycle");
    if (!Array.isArray(candidate) && Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) throw new Error("JSON document contains a non-plain object");
    ancestors.add(candidate);
    (Array.isArray(candidate) ? candidate : Object.values(candidate as Record<string, unknown>)).forEach(visit);
    ancestors.delete(candidate);
  };
  visit(value);
}

function outputValidator(schema: JsonSchema): ValidateFunction {
  if (!outputCompiler.validateSchema(schema)) throw new Error(outputCompiler.errorsText(outputCompiler.errors));
  return outputCompiler.compile(schema);
}

function attachCompatibilityAccessors(graph: GraphFlow): void {
  defineAliases(graph.budget, {
    maxActiveReadOnlyNodes: () => graph.budget.maxActiveReadOnly,
    maxDepth: () => graph.budget.maxChildDepth,
    maxCostUsd: () => graph.budget.maxCostMicrousd === undefined ? undefined : graph.budget.maxCostMicrousd / 1_000_000,
  });
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  for (const node of graph.nodes) defineAliases(node, { id: () => node.nodeId, kind: () => node.stageKind, inputSchema: () => ({ type: "object" }) });
  for (const edge of graph.edges) {
    const target = nodes.get(edge.targetId)!;
    defineAliases(edge, { id: () => edge.edgeId, from: () => edge.sourceId, to: () => edge.targetId, join: () => target.joinPolicy });
    const condition = edge.condition;
    if (condition.kind === "outcome") defineAliases(condition, { outcome: () => condition.outcomes.length === 1 ? legacyOutcome(condition.outcomes[0]!) : undefined });
    else defineAliases(condition, { route: () => condition.routes.length === 1 ? condition.routes[0] : undefined });
  }
}

function legacyOutcome(outcome: CanonicalNodeOutcome): NodeOutcome {
  if (outcome === "succeeded") return "success";
  if (outcome === "failed") return "failure";
  return outcome;
}

function canonicalConditionIdentity(condition: GraphEdgeCondition): string {
  return canonicalJson(condition.kind === "outcome"
    ? { kind: condition.kind, outcomes: [...condition.outcomes].sort() }
    : { kind: condition.kind, routes: [...condition.routes].sort() });
}

function defineAliases(target: object, aliases: Record<string, () => unknown>): void {
  for (const [name, get] of Object.entries(aliases)) Object.defineProperty(target, name, { configurable: false, enumerable: false, get });
}
function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
