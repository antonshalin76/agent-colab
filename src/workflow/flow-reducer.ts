import { buildFlowGraph } from "./flow-graph.js";
import type { GraphEdge, GraphFlow, JoinPolicy, NodeOutcome } from "./flow-contract.js";

export type GraphNodeStatus =
  | "pending"
  | "ready"
  | "awaiting_authority"
  | "admitting"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "blocked"
  | "needs_reconciliation";

export type EdgeDecision = "undecided" | "activated" | "inactive";

export interface FlowNodeProjection {
  readonly status: GraphNodeStatus;
  readonly outcome?: NodeOutcome;
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface FlowState {
  readonly flowId: string;
  readonly revision: number;
  readonly nodes: Readonly<Record<string, FlowNodeProjection>>;
  readonly edges: Readonly<Record<string, EdgeDecision>>;
}

export type FlowEvent =
  | { readonly type: "node_started"; readonly nodeId: string }
  | { readonly type: "node_succeeded"; readonly nodeId: string; readonly result: Readonly<Record<string, unknown>> }
  | { readonly type: "node_failed"; readonly nodeId: string }
  | { readonly type: "node_cancelled"; readonly nodeId: string }
  | { readonly type: "node_needs_reconciliation"; readonly nodeId: string };

const FINAL = new Set<GraphNodeStatus>(["succeeded", "failed", "cancelled", "skipped", "blocked"]);

export function initialFlowState(graph: GraphFlow): FlowState {
  const index = buildFlowGraph(graph);
  if (index.roots.length !== 1) throw new Error("graph must have exactly one root");
  const root = index.roots[0]!;
  return freezeState({
    flowId: graph.flowId,
    revision: 0,
    nodes: Object.fromEntries(graph.nodes.map((node) => [node.id, { status: node.id === root ? "ready" : "pending" }])),
    edges: Object.fromEntries(graph.edges.map((edge) => [edge.id, "undecided"])),
  });
}

export function reduceFlow(graph: GraphFlow, current: FlowState, event: FlowEvent): FlowState {
  assertCompatible(graph, current);
  const existing = current.nodes[event.nodeId];
  if (!existing) throw new Error(`unknown node ${event.nodeId}`);
  if (FINAL.has(existing.status) || existing.status === "needs_reconciliation") throw new Error(`node ${event.nodeId} is already terminal or ambiguous`);
  if (event.type !== "node_started" && !["ready", "running", "queued", "admitting"].includes(existing.status)) {
    throw new Error(`node ${event.nodeId} cannot terminate from ${existing.status}`);
  }

  const nodes: Record<string, FlowNodeProjection> = structuredClone(current.nodes);
  const edges: Record<string, EdgeDecision> = { ...current.edges };
  if (event.type === "node_started") {
    if (!["ready", "queued", "admitting"].includes(existing.status)) throw new Error(`node ${event.nodeId} cannot start from ${existing.status}`);
    nodes[event.nodeId] = { status: "running" };
  } else if (event.type === "node_succeeded") {
    nodes[event.nodeId] = { status: "succeeded", outcome: "success", result: structuredClone(event.result) };
    evaluateOutgoing(graph, event.nodeId, "success", event.result, edges);
  } else if (event.type === "node_failed") {
    nodes[event.nodeId] = { status: "failed", outcome: "failure" };
    evaluateOutgoing(graph, event.nodeId, "failure", undefined, edges);
  } else if (event.type === "node_cancelled") {
    nodes[event.nodeId] = { status: "cancelled", outcome: "cancelled" };
    evaluateOutgoing(graph, event.nodeId, "cancelled", undefined, edges);
  } else {
    nodes[event.nodeId] = { status: "needs_reconciliation" };
  }

  settleDerivedNodes(graph, nodes, edges);
  return freezeState({ flowId: current.flowId, revision: current.revision + 1, nodes, edges });
}

export function readyNodeIds(state: FlowState): string[] {
  return Object.entries(state.nodes).filter(([, node]) => node.status === "ready").map(([id]) => id);
}

export function flowIsTerminal(state: FlowState): boolean {
  return Object.values(state.nodes).every((node) => FINAL.has(node.status));
}

export function flowTerminalStatus(state: FlowState): "running" | "needs_reconciliation" | "cancelled" | "failed" | "succeeded" {
  const statuses = Object.values(state.nodes).map((node) => node.status);
  if (statuses.includes("needs_reconciliation")) return "needs_reconciliation";
  if (!statuses.every((status) => FINAL.has(status))) return "running";
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.some((status) => status === "failed" || status === "blocked")) return "failed";
  return "succeeded";
}

function settleDerivedNodes(graph: GraphFlow, nodes: Record<string, FlowNodeProjection>, edges: Record<string, EdgeDecision>): void {
  const index = buildFlowGraph(graph);
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of index.topologicalOrder) {
      if (nodes[nodeId]!.status !== "pending") continue;
      const incoming = index.incoming.get(nodeId)!;
      if (incoming.length === 0 || incoming.some((edge) => edges[edge.id] === "undecided")) continue;
      const active = incoming.filter((edge) => edges[edge.id] === "activated");
      if (active.length === 0) {
        nodes[nodeId] = { status: "skipped", outcome: "skipped" };
        evaluateOutgoing(graph, nodeId, "skipped", undefined, edges);
        changed = true;
        continue;
      }
      const parentStates = active.map((edge) => nodes[edge.from]!);
      if (parentStates.some((parent) => parent.status === "needs_reconciliation")) {
        continue;
      }
      if (parentStates.some((parent) => !FINAL.has(parent.status))) continue;
      const policy = joinFor(active);
      if (policy === "all_success" && parentStates.some((parent) => parent.status !== "succeeded")) {
        nodes[nodeId] = { status: "blocked", outcome: "blocked" };
        evaluateOutgoing(graph, nodeId, "blocked", undefined, edges);
      } else {
        nodes[nodeId] = { status: "ready" };
      }
      changed = true;
    }
  }
}

function joinFor(edges: readonly GraphEdge[]): JoinPolicy {
  const policies = new Set(edges.map((edge) => edge.join));
  if (policies.size !== 1) throw new Error("activated incoming edges have inconsistent join policy");
  return edges[0]!.join;
}

function evaluateOutgoing(
  graph: GraphFlow,
  sourceId: string,
  outcome: NodeOutcome,
  result: Readonly<Record<string, unknown>> | undefined,
  edges: Record<string, EdgeDecision>,
): void {
  for (const edge of graph.edges.filter((candidate) => candidate.from === sourceId)) {
    if (edges[edge.id] !== "undecided") throw new Error(`edge ${edge.id} was already evaluated`);
    const condition = edge.condition;
    const active = condition === undefined
      || (condition.outcome !== undefined && condition.outcome === outcome)
      || (condition.route !== undefined && result?.route === condition.route);
    edges[edge.id] = active ? "activated" : "inactive";
  }
}

function assertCompatible(graph: GraphFlow, state: FlowState): void {
  if (graph.flowId !== state.flowId) throw new Error("flow state belongs to another graph");
  if (graph.nodes.some((node) => state.nodes[node.id] === undefined) || graph.edges.some((edge) => state.edges[edge.id] === undefined)) {
    throw new Error("flow state does not match graph definition");
  }
}

function freezeState(state: FlowState): FlowState {
  for (const node of Object.values(state.nodes)) {
    if (node.result) Object.freeze(node.result);
    Object.freeze(node);
  }
  Object.freeze(state.nodes);
  Object.freeze(state.edges);
  return Object.freeze(state);
}
