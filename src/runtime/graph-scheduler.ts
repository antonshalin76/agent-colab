import type { GraphFlow } from "../workflow/flow-contract.js";
import { readyNodeIds, type FlowState } from "../workflow/flow-reducer.js";

export interface ReadyNodeBatch {
  readonly readOnly: readonly string[];
  readonly serialized: readonly string[];
}

export function scheduleReadyNodes(graph: GraphFlow, state: FlowState): ReadyNodeBatch {
  if (graph.flowId !== state.flowId) throw new Error("scheduler state belongs to another flow");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const readOnly: string[] = [];
  const serialized: string[] = [];
  for (const nodeId of readyNodeIds(state)) {
    const node = byId.get(nodeId);
    if (!node) throw new Error(`ready node ${nodeId} is absent from graph`);
    if (node.approvalScope === "workspace-read") readOnly.push(nodeId);
    else serialized.push(nodeId);
  }
  return Object.freeze({ readOnly: Object.freeze(readOnly), serialized: Object.freeze(serialized) });
}

export async function runReadOnlyFanOut<T, R>(
  values: readonly T[],
  concurrency: number,
  execute: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("read-only concurrency must be an integer in [1, 3]");
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await execute(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
