import { describe, expect, it } from "vitest";
import {
  computeGraphDefinitionSha256,
  computeJsonSha256,
  NODE_RESULT_VALIDATOR_VERSION,
  type NodeResultExpectation,
  validateGraphFlow,
  validateNodeResultV1,
} from "../src/workflow/flow-contract.js";

const SHA = "a".repeat(64);

const graphNode = (nodeId: string, stageKind = "implementation") => ({
  nodeId,
  stageKind,
  role: stageKind === "coordination" ? "coordinator" : "stage-owner",
  approvalScope: "workspace-read",
  promptTemplateRef: `prompt:${nodeId}`,
  artifactRef: `artifact:${nodeId}`,
  inputPorts: [],
  outputSchema: {
    type: "object",
    properties: { route: { type: "string", enum: ["accept", "revise"] } },
    required: ["route"],
    additionalProperties: false,
  },
  joinPolicy: "all_success",
  allowedRoutes: ["accept", "revise"],
  timeoutMs: 60_000,
  maxAttempts: 2,
  requestedTokenLimit: 1_000,
});

function unsignedFlow() {
  return {
    schemaVersion: "GraphFlow/v1",
    flowId: "flow-1",
    taskId: "task-1",
    project: "/tmp/project",
    origin: "codex",
    budget: {
      maxNodes: 8,
      maxActiveReadOnly: 3,
      maxChildDepth: 2,
      maxTokens: 20_000,
      maxWallTimeMs: 600_000,
      maxCostMicrousd: 2_000_000,
    },
    nodes: [
      graphNode("root", "coordination"),
      graphNode("left"),
      graphNode("right", "testing"),
      { ...graphNode("join", "review"), joinPolicy: "all_terminal" },
    ],
    edges: [
      { edgeId: "root-left", sourceId: "root", targetId: "left", condition: { kind: "outcome", outcomes: ["succeeded"] } },
      { edgeId: "root-right", sourceId: "root", targetId: "right", condition: { kind: "route", routes: ["accept"] } },
      { edgeId: "left-join", sourceId: "left", targetId: "join", condition: { kind: "outcome", outcomes: ["succeeded", "failed"] } },
      { edgeId: "right-join", sourceId: "right", targetId: "join", condition: { kind: "outcome", outcomes: ["succeeded", "failed"] } },
    ],
  };
}

function flow() {
  const value = unsignedFlow();
  return { ...value, definitionSha256: computeGraphDefinitionSha256(value) };
}

function mutate(path: string, replacement: unknown) {
  const value = structuredClone(flow()) as Record<string, any>;
  const parts = path.split(".");
  let current = value;
  for (const part of parts.slice(0, -1)) current = current[Number.isNaN(Number(part)) ? part : Number(part)];
  current[parts.at(-1)!] = replacement;
  value.definitionSha256 = computeGraphDefinitionSha256(value);
  return value;
}

function resultFor(definition = validateGraphFlow(flow()).graph) {
  const node = definition.nodes[1]!;
  const output = { route: "accept" };
  return {
    schemaVersion: "NodeResult/v1",
    flowId: definition.flowId,
    nodeId: node.nodeId,
    workflowId: "workflow-1",
    runId: "run-1",
    attemptId: "attempt-1",
    sessionId: "session-1",
    resultSchemaSha256: computeJsonSha256(node.outputSchema),
    validatorVersion: NODE_RESULT_VALIDATOR_VERSION,
    output,
    outputSha256: computeJsonSha256(output),
    route: "accept",
    executionSnapshotSha256: SHA,
    sourceFingerprint: SHA,
    usage: {
      provenance: "provider-receipt:receipt-1",
      completeness: "exact",
      inputTokens: 10,
      outputTokens: 5,
      costMicrousd: 200,
    },
    outcome: "succeeded",
    startedAt: 1_000,
    terminalAt: 2_000,
  };
}

function expectationFor(result: ReturnType<typeof resultFor>): NodeResultExpectation {
  return {
    flowId: result.flowId, workflowId: result.workflowId, runId: result.runId,
    attemptId: result.attemptId, sessionId: result.sessionId,
    validatorVersion: result.validatorVersion,
    executionSnapshotSha256: result.executionSnapshotSha256,
    sourceFingerprint: result.sourceFingerprint,
  };
}

describe("GraphFlow/v1", () => {
  it("validates, freezes, indexes, and verifies an RFC 8785 definition digest", () => {
    const definition = flow();
    const validated = validateGraphFlow(definition);
    expect(validated.graph).toEqual(definition);
    expect(validated.index.topologicalOrder).toHaveLength(4);
    expect(Object.isFrozen(validated.graph.nodes[0])).toBe(true);
    expect(() => (validated.index.outgoing as unknown as Map<string, unknown>).set("root", [])).toThrow();
    expect(() => (validated.index.incoming as unknown as Map<string, unknown>).delete("join")).toThrow();
    expect(() => (validated.index.incoming as unknown as Map<string, unknown>).clear()).toThrow();
    expect(Object.keys(validated.graph.nodes[0]!)).not.toContain("id");
    expect(computeGraphDefinitionSha256(validated.graph)).toBe(definition.definitionSha256);
    expect(computeGraphDefinitionSha256({ ...definition, definitionSha256: "f".repeat(64) })).toBe(definition.definitionSha256);
    expect(computeJsonSha256({ n: 1e30 })).toBe(computeJsonSha256({ n: 1e30 }));
  });

  it("permits route-less outcome-only nodes and rejects undeclared route capability", () => {
    const routeLess = flow();
    (routeLess.nodes[3]! as Record<string, any>).allowedRoutes = [];
    (routeLess.nodes[3]! as Record<string, any>).outputSchema = { type: "object", additionalProperties: false };
    routeLess.definitionSha256 = computeGraphDefinitionSha256(routeLess);
    expect(validateGraphFlow(routeLess).graph.nodes[3]!.allowedRoutes).toEqual([]);

    const undeclared = flow();
    (undeclared.nodes[3]! as Record<string, any>).outputSchema = { type: "object", additionalProperties: false };
    undeclared.definitionSha256 = computeGraphDefinitionSha256(undeclared);
    expect(() => validateGraphFlow(undeclared)).toThrow(/route declaration/);
  });

  it("isolates independent output schemas that reuse the same JSON Schema id", () => {
    const stringSchema = { $id: "urn:example:shared-output", type: "string" };
    const numberSchema = { $id: "urn:example:shared-output", type: "number" };
    expect(() => computeJsonSha256(stringSchema)).not.toThrow();
    const left = flow();
    (left.nodes[3]! as Record<string, any>).allowedRoutes = [];
    (left.nodes[3]! as Record<string, any>).outputSchema = stringSchema;
    left.definitionSha256 = computeGraphDefinitionSha256(left);
    const right = flow();
    (right.nodes[3]! as Record<string, any>).allowedRoutes = [];
    (right.nodes[3]! as Record<string, any>).outputSchema = numberSchema;
    right.definitionSha256 = computeGraphDefinitionSha256(right);
    expect(() => validateGraphFlow(left)).not.toThrow();
    expect(() => validateGraphFlow(right)).not.toThrow();
  });

  it.each([
    ["missing task identity", () => { const value = flow() as Record<string, unknown>; delete value.taskId; return value; }, /taskId|required/],
    ["wrong digest", () => ({ ...flow(), definitionSha256: "0".repeat(64) }), /digest|definitionSha256/],
    ["invalid stage enum", () => mutate("nodes.1.stageKind", "coding"), /stageKind|enum/],
    ["invalid join enum", () => mutate("nodes.1.joinPolicy", "any"), /joinPolicy|enum/],
    ["invalid outcome enum", () => mutate("edges.0.condition.outcomes", ["success"]), /outcome|enum/],
    ["provider routing", () => mutate("nodes.1.provider", "grok"), /provider|additional|routing/],
    ["model routing", () => mutate("nodes.1.model", "caller-model"), /model|additional|routing/],
    ["effort routing", () => mutate("nodes.1.effort", "max"), /effort|additional|routing/],
    ["session routing", () => mutate("nodes.1.sessionId", "session"), /sessionId|additional|routing/],
    ["failover routing", () => mutate("nodes.1.failoverTarget", "claude"), /failoverTarget|additional|routing/],
    ["unknown top field", () => mutate("provider", "grok"), /provider|additional|routing/],
    ["invalid output schema", () => mutate("nodes.1.outputSchema", { type: "not-a-type" }), /outputSchema|schema/],
    ["route declaration mismatch", () => mutate("nodes.1.allowedRoutes", ["missing"]), /route declaration/],
    ["duplicate input ports", () => mutate("nodes.1.inputPorts", [{ name: "input", schemaSha256: SHA }, { name: "input", schemaSha256: SHA }]), /duplicate.*input port/],
    ["token request over flow ceiling", () => mutate("nodes.1.requestedTokenLimit", 20_001), /token/],
    ["timeout over flow ceiling", () => mutate("nodes.1.timeoutMs", 600_001), /wall|timeout/],
  ])("rejects %s", (_label, build, pattern) => {
    expect(() => validateGraphFlow(build())).toThrow(pattern);
  });

  it("rejects duplicate nodes and edges", () => {
    const duplicateNode = flow();
    duplicateNode.nodes.push(structuredClone(duplicateNode.nodes[1]!));
    duplicateNode.definitionSha256 = computeGraphDefinitionSha256(duplicateNode);
    expect(() => validateGraphFlow(duplicateNode)).toThrow(/duplicate.*node/i);

    const duplicateEdge = flow();
    duplicateEdge.edges.push({ ...structuredClone(duplicateEdge.edges[0]!), edgeId: "duplicate-identity" });
    duplicateEdge.definitionSha256 = computeGraphDefinitionSha256(duplicateEdge);
    expect(() => validateGraphFlow(duplicateEdge)).toThrow(/duplicate.*edge/i);

    const outcomePermutation = flow();
    outcomePermutation.edges.push({
      ...structuredClone(outcomePermutation.edges[2]!),
      edgeId: "duplicate-outcome-permutation",
      condition: { kind: "outcome", outcomes: ["failed", "succeeded"] },
    });
    outcomePermutation.definitionSha256 = computeGraphDefinitionSha256(outcomePermutation);
    expect(() => validateGraphFlow(outcomePermutation)).toThrow(/duplicate.*edge/i);

    const routePermutation = flow();
    routePermutation.edges[1]!.condition = { kind: "route", routes: ["accept", "revise"] };
    routePermutation.edges.push({
      ...structuredClone(routePermutation.edges[1]!),
      edgeId: "duplicate-route-permutation",
      condition: { kind: "route", routes: ["revise", "accept"] },
    });
    routePermutation.definitionSha256 = computeGraphDefinitionSha256(routePermutation);
    expect(() => validateGraphFlow(routePermutation)).toThrow(/duplicate.*edge/i);
  });

  it("rejects cycles, dangling edges, unreachable nodes, and multiple roots", () => {
    const cycle = flow();
    cycle.edges.push({ edgeId: "cycle", sourceId: "join", targetId: "root", condition: { kind: "outcome", outcomes: ["succeeded"] } });
    cycle.definitionSha256 = computeGraphDefinitionSha256(cycle);
    expect(() => validateGraphFlow(cycle)).toThrow(/cycle/);

    const dangling = flow();
    dangling.edges[0]!.targetId = "missing";
    dangling.definitionSha256 = computeGraphDefinitionSha256(dangling);
    expect(() => validateGraphFlow(dangling)).toThrow(/unknown node/);

    const unreachable = flow();
    unreachable.edges = unreachable.edges.filter((edge) => edge.sourceId !== "root" || edge.targetId !== "left");
    unreachable.definitionSha256 = computeGraphDefinitionSha256(unreachable);
    expect(() => validateGraphFlow(unreachable)).toThrow(/root|reachable/);

    const multipleRoots = flow();
    multipleRoots.nodes.push({ ...graphNode("other-root", "coordination") });
    multipleRoots.definitionSha256 = computeGraphDefinitionSha256(multipleRoots);
    expect(() => validateGraphFlow(multipleRoots)).toThrow(/exactly one root/);
  });

  it("rejects depth, count, and canonical definition size limits", () => {
    const depth = flow();
    depth.budget.maxChildDepth = 1;
    expect(() => validateGraphFlow({ ...depth, definitionSha256: computeGraphDefinitionSha256(depth) })).toThrow(/depth/);

    expect(() => validateGraphFlow(mutate("budget.maxNodes", 3))).toThrow(/maxNodes|maximum nodes/);

    const oversized = flow();
    oversized.nodes[0]!.promptTemplateRef = `prompt:${"x".repeat(2 * 1024 * 1024)}`;
    oversized.definitionSha256 = computeGraphDefinitionSha256(oversized);
    expect(() => validateGraphFlow(oversized)).toThrow(/2 MiB/);
  });
});

describe("NodeResult/v1", () => {
  it("validates all identities, typed output, hashes, route, usage, and timestamps", () => {
    const definition = validateGraphFlow(flow()).graph;
    const result = resultFor(definition);
    expect(validateNodeResultV1(definition.nodes[1]!, result, expectationFor(result))).toEqual(result);
  });

  it.each([
    ["unavailable", null, null, null],
    ["partial", 10, null, null],
    ["partial", null, 5, 0],
    ["partial", 10, 5, 0],
  ] as const)("accepts truthful %s usage accounting", (completeness, inputTokens, outputTokens, costMicrousd) => {
    const definition = validateGraphFlow(flow()).graph;
    const result = resultFor(definition);
    (result as Record<string, any>).usage = { provenance: "provider-receipt:receipt-1", completeness, inputTokens, outputTokens, costMicrousd };
    expect(validateNodeResultV1(definition.nodes[1]!, result, expectationFor(result)).usage.completeness).toBe(completeness);
  });

  it.each([
    ["missing workflow identity", (value: Record<string, any>) => { delete value.workflowId; }, /workflowId|required/],
    ["unknown field", (value: Record<string, any>) => { value.provider = "grok"; }, /provider|additional/],
    ["wrong node", (value: Record<string, any>) => { value.nodeId = "other"; }, /node identity/],
    ["wrong flow", (value: Record<string, any>) => { value.flowId = "other"; }, /flowId identity/],
    ["wrong workflow", (value: Record<string, any>) => { value.workflowId = "other"; }, /workflowId identity/],
    ["wrong run", (value: Record<string, any>) => { value.runId = "other"; }, /runId identity/],
    ["wrong attempt", (value: Record<string, any>) => { value.attemptId = "other"; }, /attemptId identity/],
    ["wrong session", (value: Record<string, any>) => { value.sessionId = "other"; }, /sessionId identity/],
    ["wrong validator", (value: Record<string, any>) => { value.validatorVersion = "other"; }, /validatorVersion identity/],
    ["wrong snapshot", (value: Record<string, any>) => { value.executionSnapshotSha256 = "b".repeat(64); }, /executionSnapshotSha256 identity/],
    ["wrong source", (value: Record<string, any>) => { value.sourceFingerprint = "b".repeat(64); }, /sourceFingerprint identity/],
    ["wrong result schema hash", (value: Record<string, any>) => { value.resultSchemaSha256 = "b".repeat(64); }, /result schema/],
    ["wrong output hash", (value: Record<string, any>) => { value.outputSha256 = "b".repeat(64); }, /output.*digest/],
    ["invalid typed output", (value: Record<string, any>) => { value.output.route = "unknown"; value.outputSha256 = computeJsonSha256(value.output); value.route = "unknown"; }, /allowed values|schema/],
    ["route mismatch", (value: Record<string, any>) => { value.route = "revise"; }, /route/],
    ["failure outcome", (value: Record<string, any>) => { value.outcome = "failed"; }, /outcome|succeeded/],
    ["invalid usage completeness", (value: Record<string, any>) => { value.usage.completeness = "unknown"; }, /completeness|enum/],
    ["exact usage with null", (value: Record<string, any>) => { value.usage.inputTokens = null; }, /contradict completeness/],
    ["unavailable usage with number", (value: Record<string, any>) => { value.usage.completeness = "unavailable"; }, /contradict completeness/],
    ["partial usage with all null", (value: Record<string, any>) => { value.usage = { ...value.usage, completeness: "partial", inputTokens: null, outputTokens: null, costMicrousd: null }; }, /contradict completeness/],
    ["negative usage", (value: Record<string, any>) => { value.usage.inputTokens = -1; }, /inputTokens|minimum/],
    ["unsafe usage integer", (value: Record<string, any>) => { value.usage.inputTokens = Number.MAX_SAFE_INTEGER + 1; }, /inputTokens|maximum/],
    ["unsafe timestamp integer", (value: Record<string, any>) => { value.terminalAt = Number.MAX_SAFE_INTEGER + 1; }, /terminalAt|maximum/],
    ["reversed timestamps", (value: Record<string, any>) => { value.terminalAt = value.startedAt - 1; }, /timestamp/],
  ])("rejects %s", (_label, change, pattern) => {
    const definition = validateGraphFlow(flow()).graph;
    const result = resultFor(definition) as Record<string, any>;
    const expected = expectationFor(result as ReturnType<typeof resultFor>);
    change(result);
    expect(() => validateNodeResultV1(definition.nodes[1]!, result, expected)).toThrow(pattern);
  });

  it("rejects a mutually agreed but non-broker validator identity", () => {
    const definition = validateGraphFlow(flow()).graph;
    const result = resultFor(definition);
    (result as Record<string, any>).validatorVersion = "bogus-validator";
    const expected = { ...expectationFor(result), validatorVersion: "bogus-validator" };
    expect(() => validateNodeResultV1(definition.nodes[1]!, result, expected)).toThrow(/broker-owned/);
  });
});
