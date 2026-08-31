import { describe, expect, it } from "vitest";
import { appendFlowEvent, aggregateUsage, verifyFlowEvent } from "../src/runtime/flow-telemetry.js";
import { runReadOnlyFanOut } from "../src/runtime/graph-scheduler.js";
import { validateNodeResult } from "../src/runtime/node-result.js";
import { createSessionCheckpoint, verifySessionCheckpoint } from "../src/runtime/session-context.js";
import { computeGraphDefinitionSha256, validateGraphFlow } from "../src/workflow/flow-contract.js";
import { flowIsTerminal, initialFlowState, readyNodeIds, reduceFlow } from "../src/workflow/flow-reducer.js";

const node = (nodeId: string, stageKind = "implementation") => ({
  nodeId,
  stageKind,
  role: stageKind === "coordination" ? "coordinator" : "stage-owner",
  approvalScope: "workspace-read",
  promptTemplateRef: `prompt:${nodeId}`,
  artifactRef: `artifact:${nodeId}`,
  inputPorts: [],
  outputSchema: {
    type: "object",
    properties: { route: { type: "string", enum: ["yes", "no"] } },
    required: ["route"],
    additionalProperties: false,
  },
  joinPolicy: "all_success",
  allowedRoutes: ["yes", "no"],
  timeoutMs: 60_000,
  maxAttempts: 2,
  requestedTokenLimit: 1_000,
});

const flow = () => {
  const definition = {
    schemaVersion: "GraphFlow/v1",
    flowId: "focused",
    taskId: "focused-task",
    project: "/tmp/project",
    origin: "codex",
    budget: { maxNodes: 8, maxActiveReadOnly: 3, maxChildDepth: 8, maxTokens: 20_000, maxWallTimeMs: 600_000, maxCostMicrousd: 1_000_000 },
    nodes: [node("root", "coordination"), node("left"), node("right"), node("join"), { ...node("conditional"), joinPolicy: "all_terminal" }],
    edges: [
      { edgeId: "root-left", sourceId: "root", targetId: "left", condition: { kind: "outcome", outcomes: ["succeeded"] } },
      { edgeId: "root-right", sourceId: "root", targetId: "right", condition: { kind: "outcome", outcomes: ["succeeded"] } },
      { edgeId: "left-join", sourceId: "left", targetId: "join", condition: { kind: "outcome", outcomes: ["succeeded"] } },
      { edgeId: "right-join", sourceId: "right", targetId: "join", condition: { kind: "outcome", outcomes: ["succeeded"] } },
      { edgeId: "join-conditional", sourceId: "join", targetId: "conditional", condition: { kind: "route", routes: ["yes"] } },
    ],
  };
  return { ...definition, definitionSha256: computeGraphDefinitionSha256(definition) };
};

describe("graph flow contracts and reducer", () => {
  it("validates a single-root DAG and rejects cycles, dangling edges, and routing authority", () => {
    expect(validateGraphFlow(flow()).index.topologicalOrder).toHaveLength(5);
    const cycle = flow();
    cycle.edges.push({ edgeId: "cycle", sourceId: "join", targetId: "root", condition: { kind: "outcome", outcomes: ["succeeded"] } });
    cycle.definitionSha256 = computeGraphDefinitionSha256(cycle);
    expect(() => validateGraphFlow(cycle)).toThrow(/cycle/);
    const dangling = flow();
    dangling.edges[0]!.targetId = "missing";
    dangling.definitionSha256 = computeGraphDefinitionSha256(dangling);
    expect(() => validateGraphFlow(dangling)).toThrow(/unknown node/);
    expect(() => validateGraphFlow({ ...flow(), budget: { maxNodes: 8, maxDepth: 3 } })).toThrow(/maxDepth|additional properties/);
    const badRoute = flow();
    badRoute.edges.push({ edgeId: "bad-route", sourceId: "join", targetId: "left", condition: { kind: "route", routes: ["maybe"] } });
    badRoute.definitionSha256 = computeGraphDefinitionSha256(badRoute);
    expect(() => validateGraphFlow(badRoute)).toThrow(/not declared/);
    const secondRoot = flow();
    secondRoot.nodes.push(node("second-root", "coordination"));
    secondRoot.definitionSha256 = computeGraphDefinitionSha256(secondRoot);
    expect(() => validateGraphFlow(secondRoot)).toThrow(/exactly one root/);
    const withProvider = flow();
    const providerDefinition = { ...withProvider, nodes: [{ ...withProvider.nodes[0], provider: "caller-selected" }, ...withProvider.nodes.slice(1)] };
    providerDefinition.definitionSha256 = computeGraphDefinitionSha256(providerDefinition);
    expect(() => validateGraphFlow(providerDefinition)).toThrow(/provider|additional/);
  });

  it("fans out, waits for all_success, and terminally skips an inactive route", () => {
    const graph = validateGraphFlow(flow()).graph;
    let state = initialFlowState(graph);
    state = reduceFlow(graph, state, { type: "node_succeeded", nodeId: "root", result: { route: "yes" } });
    expect(readyNodeIds(state)).toEqual(["left", "right"]);
    state = reduceFlow(graph, state, { type: "node_succeeded", nodeId: "left", result: { route: "yes" } });
    expect(readyNodeIds(state)).not.toContain("join");
    state = reduceFlow(graph, state, { type: "node_succeeded", nodeId: "right", result: { route: "yes" } });
    expect(readyNodeIds(state)).toContain("join");
    state = reduceFlow(graph, state, { type: "node_succeeded", nodeId: "join", result: { route: "no" } });
    expect(state.nodes.conditional?.status).toBe("skipped");
    expect(flowIsTerminal(state)).toBe(true);
  });

  it("opens all_terminal after failure but blocks an all_success join", () => {
    const definition = flow();
    definition.nodes[3]!.joinPolicy = "all_terminal";
    definition.edges.push({
      edgeId: "left-join-failed",
      sourceId: "left",
      targetId: "join",
      condition: { kind: "outcome", outcomes: ["failed"] },
    });
    definition.definitionSha256 = computeGraphDefinitionSha256(definition);
    const graph = validateGraphFlow(definition).graph;
    let state = reduceFlow(graph, initialFlowState(graph), { type: "node_succeeded", nodeId: "root", result: { route: "yes" } });
    state = reduceFlow(graph, state, { type: "node_failed", nodeId: "left" });
    state = reduceFlow(graph, state, { type: "node_succeeded", nodeId: "right", result: { route: "yes" } });
    expect(readyNodeIds(state)).toContain("join");
  });
});

describe("typed results, memory, telemetry, and bounded fan-out", () => {
  it("accepts schema-valid output and rejects invalid routes and extra properties", () => {
    const graphNode = validateGraphFlow(flow()).graph.nodes[0]!;
    expect(validateNodeResult(graphNode, {
      schemaVersion: "NodeResult/v1", nodeId: "root", outcome: "success",
      output: { route: "yes" }, usage: { completeness: "unavailable" },
    }).outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateNodeResult(graphNode, {
      schemaVersion: "NodeResult/v1", nodeId: "root", outcome: "success",
      output: { route: "invalid" }, usage: { completeness: "unavailable" },
    })).toThrow(/allowed values/);
    expect(() => validateNodeResult(graphNode, {
      schemaVersion: "NodeResult/v1", nodeId: "root", outcome: "success",
      output: { route: "yes", surprise: true }, usage: { completeness: "unavailable" },
    })).toThrow(/additional properties/);
    expect(() => validateNodeResult(graphNode, {
      schemaVersion: "NodeResult/v1", nodeId: "root", outcome: "success", outputHash: "0".repeat(64),
      output: { route: "yes" }, usage: { completeness: "unavailable" },
    })).toThrow(/hash mismatch/);
  });

  it("hash-chains session checkpoints and rejects cross-session reuse", () => {
    const first = createSessionCheckpoint({ project: "/tmp/p", flowId: "flow-a", sessionId: "session-a", body: { objective: "test" } });
    const second = createSessionCheckpoint({ project: "/tmp/p", flowId: "flow-a", sessionId: "session-a", body: { objective: "test", nextAction: "continue" }, previous: first });
    expect(() => verifySessionCheckpoint(second, first)).not.toThrow();
    expect(() => createSessionCheckpoint({ project: "/tmp/p", flowId: "flow-b", sessionId: "session-a", body: { objective: "wrong" }, previous: first })).toThrow(/cross-flow|scope/);
    expect(() => verifySessionCheckpoint({ ...first, body: { objective: "tampered" } })).toThrow(/hash mismatch/);
    expect(() => createSessionCheckpoint({ project: "/tmp/p", flowId: "flow-a", sessionId: "session-a", body: { objective: "test", apiToken: "secret" } as never })).toThrow(/secret/);
  });

  it("keeps unknown usage unknown and hash-chains bounded events", () => {
    expect(aggregateUsage([{ inputTokens: 10, outputTokens: 2, completeness: "exact" }, { completeness: "unavailable" }])).toEqual({
      inputTokens: 10, outputTokens: 2, costMicroUsd: null, completeness: "partial",
    });
    expect(aggregateUsage([{ completeness: "unavailable" }]).completeness).toBe("unavailable");
    const first = appendFlowEvent({ flowId: "flow", sequenceNo: 0, eventType: "created", occurredAt: 1, payload: { safe: true } });
    const second = appendFlowEvent({ flowId: "flow", sequenceNo: 1, eventType: "ready", occurredAt: 2, payload: {} }, first);
    expect(() => verifyFlowEvent(second, first)).not.toThrow();
    expect(() => verifyFlowEvent({ ...second, payload: { tampered: true } }, first)).toThrow(/hash mismatch/);
  });

  it("runs read-only work at bounded concurrency and preserves result order", async () => {
    let active = 0;
    let maximum = 0;
    const results = await runReadOnlyFanOut([0, 1, 2, 3], 3, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });
    expect(results).toEqual([0, 2, 4, 6]);
    expect(maximum).toBe(3);
    await expect(runReadOnlyFanOut([1], 4, async (value) => value)).rejects.toThrow(/concurrency/);
  });
});
