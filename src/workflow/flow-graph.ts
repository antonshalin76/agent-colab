import { Graph, alg } from "@dagrejs/graphlib";
import type { GraphEdge, GraphFlow } from "./flow-contract.js";

export interface FlowGraphIndex {
  readonly nodeIds: readonly string[];
  readonly roots: readonly string[];
  readonly topologicalOrder: readonly string[];
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
}

export function buildFlowGraph(graph: GraphFlow): FlowGraphIndex {
  const nodeIds = graph.nodes.map((node) => node.id);
  const incoming = new Map<string, GraphEdge[]>(nodeIds.map((id) => [id, []]));
  const outgoing = new Map<string, GraphEdge[]>(nodeIds.map((id) => [id, []]));
  const libraryGraph = new Graph<undefined, undefined, GraphEdge>({ directed: true, multigraph: true });
  nodeIds.forEach((id) => libraryGraph.setNode(id));

  for (const edge of graph.edges) {
    if (!libraryGraph.hasNode(edge.from) || !libraryGraph.hasNode(edge.to)) {
      throw new Error(`edge ${edge.id} references an unknown node`);
    }
    outgoing.get(edge.from)!.push(edge);
    incoming.get(edge.to)!.push(edge);
    libraryGraph.setEdge(edge.from, edge.to, edge, edge.id);
  }

  if (!alg.isAcyclic(libraryGraph)) throw new Error("graph contains a cycle");
  const roots = libraryGraph.sources();
  const order = alg.topsort(libraryGraph);

  return {
    nodeIds: Object.freeze([...nodeIds]),
    roots: Object.freeze(roots),
    topologicalOrder: Object.freeze(order),
    incoming: freezeEdgeMap(incoming),
    outgoing: freezeEdgeMap(outgoing),
  };
}

export function graphDepth(index: FlowGraphIndex): number {
  const depth = new Map<string, number>();
  let maximum = 0;
  for (const nodeId of index.topologicalOrder) {
    const parents = index.incoming.get(nodeId)!;
    const value = parents.length === 0
      ? 1
      : 1 + Math.max(...parents.map((edge) => depth.get(edge.from)!));
    depth.set(nodeId, value);
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function freezeEdgeMap(source: Map<string, GraphEdge[]>): ReadonlyMap<string, readonly GraphEdge[]> {
  return new Map([...source].map(([key, edges]) => [key, Object.freeze([...edges])]));
}
