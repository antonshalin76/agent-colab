import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { buildFlowGraph, graphDepth, type FlowGraphIndex } from "./flow-graph.js";

export type JoinPolicy = "all_success" | "all_terminal";
export type NodeOutcome = "success" | "failure" | "cancelled" | "skipped" | "blocked";

export interface JsonSchema {
  readonly [key: string]: unknown;
}

export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly role?: string;
  readonly approvalScope: "workspace-read" | "workspace-write" | "external";
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly joinPolicy: JoinPolicy;
  readonly allowedRoutes: readonly string[];
}

export interface GraphEdgeCondition {
  readonly route?: string;
  readonly outcome?: NodeOutcome;
}

export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly join: JoinPolicy;
  readonly condition?: GraphEdgeCondition;
}

export interface GraphBudget {
  readonly maxNodes: number;
  readonly maxCostUsd?: number;
  readonly maxActiveReadOnlyNodes: number;
  readonly maxDepth: number;
}

export interface GraphFlow {
  readonly schemaVersion: "GraphFlow/v1";
  readonly flowId: string;
  readonly project: string;
  readonly budget: GraphBudget;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface ValidatedGraphFlow {
  readonly graph: GraphFlow;
  readonly index: FlowGraphIndex;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NODE_KEYS = new Set(["id", "nodeId", "kind", "role", "approvalScope", "inputSchema", "outputSchema", "joinPolicy", "allowedRoutes"]);
const EDGE_KEYS = new Set(["id", "edgeId", "from", "sourceId", "to", "targetId", "join", "condition"]);
const FORBIDDEN_NODE_KEYS = new Set(["provider", "model", "effort", "sessionId", "failover", "failoverTarget"]);
const schemaCompiler = new Ajv2020({ strict: true, allErrors: true, validateSchema: true });
const compiledSchemas = new Map<string, ValidateFunction>();

export function validateGraphFlow(input: unknown): ValidatedGraphFlow {
  assertJsonDocument(input);
  if (Buffer.byteLength(canonicalJson(input)) > 2 * 1024 * 1024) throw new Error("graph definition exceeds 2 MiB");
  const value = record(input, "graph flow");
  rejectUnknownKeys(value, new Set(["schemaVersion", "flowId", "taskId", "project", "origin", "definitionSha256", "budget", "nodes", "edges"]), "graph flow");
  if (value.schemaVersion !== "GraphFlow/v1") throw new Error("unsupported graph schemaVersion");
  const flowId = identifier(value.flowId, "flowId");
  const project = nonEmptyString(value.project, "project", 4096);
  const budgetInput = record(value.budget, "budget");
  rejectUnknownKeys(budgetInput, new Set(["maxNodes", "maxCostUsd", "maxActiveReadOnlyNodes", "maxDepth"]), "budget");
  const maxNodes = boundedInteger(budgetInput.maxNodes, "budget.maxNodes", 1, 100);
  if (budgetInput.maxCostUsd !== undefined && (!Number.isFinite(budgetInput.maxCostUsd) || (budgetInput.maxCostUsd as number) < 0)) {
    throw new Error("budget.maxCostUsd must be a non-negative finite number");
  }
  const maxActiveReadOnlyNodes = budgetInput.maxActiveReadOnlyNodes === undefined
    ? 3
    : boundedInteger(budgetInput.maxActiveReadOnlyNodes, "budget.maxActiveReadOnlyNodes", 1, 3);
  const maxDepth = budgetInput.maxDepth === undefined
    ? 8
    : boundedInteger(budgetInput.maxDepth, "budget.maxDepth", 1, 8);

  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > maxNodes || value.nodes.length > 100) {
    throw new Error("nodes must contain between 1 and the declared maximum nodes");
  }
  if (!Array.isArray(value.edges) || value.edges.length > 400) throw new Error("edges must contain at most 400 entries");

  const nodes = value.nodes.map((raw, index) => normalizeNode(raw, index));
  unique(nodes.map((node) => node.id), "node id");
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = value.edges.map((raw, index) => normalizeEdge(raw, index));
  unique(edges.map((edge) => edge.id), "edge id");
  unique(edges.map((edge) => `${edge.from}\0${edge.to}\0${canonicalJson(edge.condition ?? null)}`), "edge identity");

  for (const edge of edges) {
    const source = nodeById.get(edge.from);
    if (!source || !nodeById.has(edge.to)) throw new Error(`edge ${edge.id} references an unknown node`);
    if (edge.from === edge.to) throw new Error(`edge ${edge.id} is a self-cycle`);
    if (edge.condition?.route !== undefined && !source.allowedRoutes.includes(edge.condition.route)) {
      throw new Error(`edge ${edge.id} route is not declared by producer ${source.id}`);
    }
  }

  for (const node of nodes) {
    const policies = new Set(edges.filter((edge) => edge.to === node.id).map((edge) => edge.join));
    if (policies.size > 1) throw new Error(`node ${node.id} has inconsistent incoming join policy`);
    const rawNode = record(value.nodes[nodes.indexOf(node)], `node[${nodes.indexOf(node)}]`);
    if (rawNode.joinPolicy !== undefined && policies.size === 1 && !policies.has(node.joinPolicy)) throw new Error(`node ${node.id} join policy disagrees with incoming edges`);
  }

  const graph: GraphFlow = deepFreeze({
    schemaVersion: "GraphFlow/v1",
    flowId,
    project,
    budget: {
      maxNodes,
      ...(budgetInput.maxCostUsd === undefined ? {} : { maxCostUsd: budgetInput.maxCostUsd as number }),
      maxActiveReadOnlyNodes,
      maxDepth,
    },
    nodes,
    edges,
  });
  const index = buildFlowGraph(graph);
  if (index.roots.length !== 1) throw new Error("graph must have exactly one root");
  const root = nodeById.get(index.roots[0]!)!;
  if (root.kind !== "coordination") throw new Error("graph root must be a coordination node");
  const reachable = new Set<string>();
  const visit = [root.id];
  while (visit.length > 0) {
    const nodeId = visit.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    index.outgoing.get(nodeId)!.forEach((edge) => visit.push(edge.to));
  }
  if (reachable.size !== graph.nodes.length) throw new Error("every graph node must be reachable from the coordination root");
  if (graphDepth(index) > graph.budget.maxDepth) throw new Error("graph exceeds budget.maxDepth");
  return { graph, index };
}

function normalizeNode(input: unknown, index: number): GraphNode {
  const value = record(input, `node[${index}]`);
  for (const key of Object.keys(value)) if (FORBIDDEN_NODE_KEYS.has(key)) throw new Error(`node[${index}] contains forbidden routing field ${key}`);
  rejectUnknownKeys(value, NODE_KEYS, `node[${index}]`);
  const id = identifier(value.id ?? value.nodeId, `node[${index}].id`);
  const kind = nonEmptyString(value.kind, `node[${index}].kind`, 64);
  const role = value.role === undefined ? undefined : nonEmptyString(value.role, `node[${index}].role`, 64);
  if (!(["workspace-read", "workspace-write", "external"] as const).includes(value.approvalScope as never)) throw new Error(`node[${index}].approvalScope is invalid`);
  const approvalScope = value.approvalScope as GraphNode["approvalScope"];
  const inputSchema = validateJsonSchema(value.inputSchema ?? { type: "object" }, `node[${index}].inputSchema`);
  const outputSchema = validateJsonSchema(value.outputSchema, `node[${index}].outputSchema`);
  const normalizedJoinPolicy = parseJoinPolicy(value.joinPolicy ?? "all_success", `node[${index}].joinPolicy`);
  const allowedRoutes = extractRoutes(outputSchema, value.allowedRoutes, `node[${index}]`);
  return deepFreeze({ id, kind, ...(role === undefined ? {} : { role }), approvalScope, inputSchema, outputSchema, joinPolicy: normalizedJoinPolicy, allowedRoutes });
}

function normalizeEdge(input: unknown, index: number): GraphEdge {
  const value = record(input, `edge[${index}]`);
  rejectUnknownKeys(value, EDGE_KEYS, `edge[${index}]`);
  const from = identifier(value.from ?? value.sourceId, `edge[${index}].from`);
  const to = identifier(value.to ?? value.targetId, `edge[${index}].to`);
  const join = parseJoinPolicy(value.join ?? "all_success", `edge[${index}].join`);
  let condition: GraphEdgeCondition | undefined;
  if (value.condition !== undefined) {
    const raw = record(value.condition, `edge[${index}].condition`);
    rejectUnknownKeys(raw, new Set(["route", "outcome"]), `edge[${index}].condition`);
    if ((raw.route === undefined) === (raw.outcome === undefined)) throw new Error("edge condition must contain exactly one evaluator");
    if (raw.route !== undefined) condition = { route: nonEmptyString(raw.route, "condition.route", 128) };
    else if (["success", "failure", "cancelled", "skipped", "blocked"].includes(String(raw.outcome))) condition = { outcome: raw.outcome as NodeOutcome };
    else throw new Error("condition.outcome is invalid");
  }
  return deepFreeze({ id: identifier(value.id ?? value.edgeId ?? `edge:${index}:${from}:${to}`, `edge[${index}].id`), from, to, join, ...(condition ? { condition } : {}) });
}

export function validateJsonSchema(input: unknown, label = "schema"): JsonSchema {
  const schema = record(input, label);
  const copy = structuredClone(schema);
  try { compileJsonSchema(copy); } catch (error) {
    throw new Error(`${label} is not a strict JSON Schema 2020 document: ${error instanceof Error ? error.message : String(error)}`);
  }
  return deepFreeze(copy);
}

export function validateJsonValue(schema: JsonSchema, value: unknown): void {
  const validator = compileJsonSchema(schema);
  if (!validator(value)) throw new Error(`JSON Schema validation failed: ${schemaCompiler.errorsText(validator.errors, { separator: "; " })}`);
}

function compileJsonSchema(schema: JsonSchema): ValidateFunction {
  const key = canonicalJson(schema);
  const existing = compiledSchemas.get(key);
  if (existing) return existing;
  const validator = schemaCompiler.compile(schema);
  compiledSchemas.set(key, validator);
  return validator;
}

function extractRoutes(schema: JsonSchema, declared: unknown, label: string): readonly string[] {
  const fromDeclaration = declared === undefined ? undefined : stringArray(declared, `${label}.allowedRoutes`);
  const properties = schema.properties as Record<string, unknown> | undefined;
  const routeSchema = properties?.route as Record<string, unknown> | undefined;
  const fromSchema = routeSchema?.enum === undefined ? [] : stringArray(routeSchema.enum, `${label}.outputSchema.properties.route.enum`);
  if (fromDeclaration && canonicalJson([...fromDeclaration].sort()) !== canonicalJson([...fromSchema].sort())) throw new Error(`${label} route declarations disagree`);
  return Object.freeze([...(fromDeclaration ?? fromSchema)]);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`${label} must contain strings`);
  unique(value, label);
  return [...value];
}

function parseJoinPolicy(value: unknown, label: string): JoinPolicy {
  if (value !== "all_success" && value !== "all_terminal") throw new Error(`${label} is invalid`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  const result = nonEmptyString(value, label, 128);
  if (!ID.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function nonEmptyString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
  return value as number;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`);
}

export function canonicalJson(value: unknown): string {
  assertJsonDocument(value);
  return canonicalJsonUnchecked(value);
}

function canonicalJsonUnchecked(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonUnchecked).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonUnchecked(object[key])}`).join(",")}}`;
}

export function assertJsonDocument(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("JSON document contains a non-finite number");
      return;
    }
    if (typeof candidate !== "object") throw new Error("value is not a JSON document");
    if (ancestors.has(candidate)) throw new Error("JSON document contains a cycle");
    if (!Array.isArray(candidate) && Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) throw new Error("JSON document contains a non-plain object");
    ancestors.add(candidate);
    if (Array.isArray(candidate)) candidate.forEach(visit);
    else Object.values(candidate as Record<string, unknown>).forEach(visit);
    ancestors.delete(candidate);
  };
  visit(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
