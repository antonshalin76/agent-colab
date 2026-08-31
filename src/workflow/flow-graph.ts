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
  const nodeIds = graph.nodes.map((node) => node.nodeId);
  const incoming = new Map<string, GraphEdge[]>(nodeIds.map((id) => [id, []]));
  const outgoing = new Map<string, GraphEdge[]>(nodeIds.map((id) => [id, []]));
  const libraryGraph = new Graph<undefined, undefined, GraphEdge>({ directed: true, multigraph: true });
  nodeIds.forEach((id) => libraryGraph.setNode(id));
  for (const edge of graph.edges) {
    if (!libraryGraph.hasNode(edge.sourceId) || !libraryGraph.hasNode(edge.targetId)) {
      throw new Error(`edge ${edge.edgeId} references an unknown node`);
    }
    incoming.get(edge.targetId)!.push(edge);
    outgoing.get(edge.sourceId)!.push(edge);
    libraryGraph.setEdge(edge.sourceId, edge.targetId, edge, edge.edgeId);
  }
  if (!alg.isAcyclic(libraryGraph)) throw new Error("graph contains a cycle");
  return Object.freeze({
    nodeIds: Object.freeze(nodeIds),
    roots: Object.freeze(libraryGraph.sources()),
    topologicalOrder: Object.freeze(alg.topsort(libraryGraph)),
    incoming: freezeEdgeMap(incoming),
    outgoing: freezeEdgeMap(outgoing),
  });
}

export function graphDepth(index: FlowGraphIndex): number {
  const depths = new Map<string, number>();
  let maximum = 0;
  for (const nodeId of index.topologicalOrder) {
    const parents = index.incoming.get(nodeId)!;
    const depth = parents.length === 0
      ? 0
      : 1 + Math.max(...parents.map((edge) => depths.get(edge.sourceId)!));
    depths.set(nodeId, depth);
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

function freezeEdgeMap(source: Map<string, GraphEdge[]>): ReadonlyMap<string, readonly GraphEdge[]> {
  return Object.freeze(new ImmutableMap(
    new Map([...source].map(([key, edges]) => [key, Object.freeze([...edges])])),
  ));
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #source: Map<K, V>;
  constructor(source: Map<K, V>) { this.#source = source; }
  get size(): number { return this.#source.size; }
  has(key: K): boolean { return this.#source.has(key); }
  get(key: K): V | undefined { return this.#source.get(key); }
  entries(): MapIterator<[K, V]> { return this.#source.entries(); }
  keys(): MapIterator<K> { return this.#source.keys(); }
  values(): MapIterator<V> { return this.#source.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#source.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
}
