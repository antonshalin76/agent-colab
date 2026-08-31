#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contractPath = join(root, "evals/hybrid-flow-v2/eval-contract.json");
const runnerPath = fileURLToPath(import.meta.url);
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const median = (values) => percentile(values, 0.5);
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const label = option("--label", "unlabelled");
const output = resolve(root, option("--output", `.artifacts/hybrid-flow-v2/${label}.json`));
const runtimeRoot = resolve(option("--runtime-root", root));
const importBuilt = async (relative) => import(pathToFileURL(join(runtimeRoot, "dist", relative)).href);
const results = new Map(contract.functionalCases.map((id) => [id, { id, status: "unsupported" }]));
const pass = (id, evidence) => results.set(id, { id, status: "pass", evidence });
const fail = (id, error) => results.set(id, { id, status: "fail", error: error instanceof Error ? error.message : String(error) });

const graphFixture = () => {
  const layerSizes = [1, 15, 14, 14, 14, 14, 14, 14];
  const layers = []; let cursor = 0;
  for (const size of layerSizes) layers.push(Array.from({ length: size }, () => `n${cursor++}`));
  const nodes = layers.flat().map((nodeId, index) => ({
    nodeId, kind: index === 0 ? "coordination" : "task", approvalScope: "workspace-read",
    outputSchema: { type: "object", properties: { route: { enum: ["yes", "no"] } }, required: ["route"], additionalProperties: false },
    joinPolicy: "all_success",
  }));
  const pairs = [];
  for (let level = 1; level < layers.length; level += 1) {
    const previous = layers[level - 1]; const current = layers[level];
    for (let index = 0; index < current.length; index += 1) pairs.push([previous[index % previous.length], current[index]]);
  }
  for (let level = 1; level < layers.length && pairs.length < 400; level += 1) {
    const previous = layers[level - 1]; const current = layers[level];
    for (const from of previous) for (const to of current) if (!pairs.some(([a, b]) => a === from && b === to)) pairs.push([from, to]);
  }
  const edges = pairs.slice(0, 400).map(([sourceId, targetId], index) => ({ edgeId: `edge:${index}`, sourceId, targetId, join: "all_success" }));
  return { schemaVersion: "GraphFlow/v1", flowId: "eval-100-400", project: runtimeRoot,
    budget: { maxNodes: 100, maxCostUsd: 1, maxActiveReadOnlyNodes: 3, maxDepth: 8 }, nodes, edges };
};

const smallFixture = () => ({ schemaVersion: "GraphFlow/v1", flowId: "functional", project: runtimeRoot,
  budget: { maxNodes: 8, maxCostUsd: 1, maxActiveReadOnlyNodes: 3, maxDepth: 4 },
  nodes: ["n0", "n1", "n2", "n3", "n4"].map((nodeId, index) => ({ nodeId,
    kind: index === 0 ? "coordination" : "task", approvalScope: "workspace-read",
    outputSchema: { type: "object", properties: { route: { enum: ["yes", "no"] } }, required: ["route"], additionalProperties: false },
    joinPolicy: index === 4 ? "all_terminal" : "all_success" })),
  edges: [
    { edgeId: "e01", sourceId: "n0", targetId: "n1", join: "all_success" },
    { edgeId: "e02", sourceId: "n0", targetId: "n2", join: "all_success" },
    { edgeId: "e13", sourceId: "n1", targetId: "n3", join: "all_success" },
    { edgeId: "e23", sourceId: "n2", targetId: "n3", join: "all_success" },
    { edgeId: "e34", sourceId: "n3", targetId: "n4", join: "all_terminal", condition: { route: "yes" } },
  ] });

const measureLegacyQueue = async () => {
  const { initializeCurrentExecutionSchema } = await importBuilt("migration/coordinator.js");
  const { RunStore } = await importBuilt("store/run-store.js"); const samples = [];
  for (let iteration = 0; iteration < contract.iterations.legacyQueue; iteration += 1) {
    const temp = mkdtempSync(join(tmpdir(), "agent-collab-eval-queue-"));
    try {
      const db = join(temp, "state.db"); initializeCurrentExecutionSchema(db); const store = new RunStore(db); let predecessor;
      const started = performance.now();
      for (let index = 0; index < 100; index += 1) predecessor = store.enqueue({ idempotencyKey: `${iteration}:${index}`, stage: "planning", priority: 1, dependsOnRunId: predecessor?.id }).id;
      for (let index = 0; index < 100; index += 1) { const run = store.claimNext({ workerId: "eval", leaseMs: 1000 }); store.complete(run.id, run.leaseToken, { ok: true }); }
      samples.push(performance.now() - started); store.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  return { medianMs: median(samples), p95Ms: percentile(samples, 0.95), samples };
};

let contracts; let reducer; let scheduler; let telemetry; let nodeResult; let sessions;
try { contracts = await importBuilt("workflow/flow-contract.js"); } catch {}
try { reducer = await importBuilt("workflow/flow-reducer.js"); } catch {}
try { scheduler = await importBuilt("runtime/graph-scheduler.js"); } catch {}
try { telemetry = await importBuilt("runtime/flow-telemetry.js"); } catch {}
try { nodeResult = await importBuilt("runtime/node-result.js"); } catch {}
try { sessions = await importBuilt("runtime/session-context.js"); } catch {}

let validatedGraph; let pureGraph = { status: "unsupported" };
if (contracts && reducer) {
  try {
    const graph = graphFixture(); const samples = [];
    for (let iteration = 0; iteration < contract.iterations.pureGraph; iteration += 1) {
      const started = performance.now(); validatedGraph = contracts.validateGraphFlow(graph).graph; reducer.initialFlowState(validatedGraph); samples.push(performance.now() - started);
    }
    pureGraph = { medianMs: median(samples), p95Ms: percentile(samples, 0.95), samples };
    pass("dag_validation", `${validatedGraph.nodes.length} nodes/${validatedGraph.edges.length} edges/depth<=8`);
  } catch (error) { fail("dag_validation", error); }
  try { const graph = graphFixture(); contracts.validateGraphFlow({ ...graph, edges: [...graph.edges, { edgeId: "cycle", sourceId: "n99", targetId: "n0", join: "all_success" }] }); fail("cycle_rejection", "cycle accepted"); } catch { pass("cycle_rejection", "cycle rejected"); }
  try {
    const small = contracts.validateGraphFlow(smallFixture()).graph; let state = reducer.initialFlowState(small);
    state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n0", result: { route: "yes" } });
    const ready = reducer.readyNodeIds(state); ready.includes("n1") && ready.includes("n2") ? pass("fan_out_readiness", ready) : fail("fan_out_readiness", ready);
    state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n1", result: { route: "yes" } });
    const openedEarly = reducer.readyNodeIds(state).includes("n3");
    state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n2", result: { route: "yes" } });
    !openedEarly && reducer.readyNodeIds(state).includes("n3") ? pass("all_success_join", "opened only after both parents") : fail("all_success_join", "join timing mismatch");
    state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n3", result: { route: "yes" } });
    reducer.readyNodeIds(state).includes("n4") ? pass("all_terminal_join", "terminal parent opened consumer") : fail("all_terminal_join", "consumer closed");
    state.edges.e34 === "activated" ? pass("conditional_route", "matching route activated exactly once") : fail("conditional_route", state.edges.e34);
    let noRoute = reducer.initialFlowState(small);
    for (const nodeId of ["n0", "n1", "n2"]) noRoute = reducer.reduceFlow(small, noRoute, { type: "node_succeeded", nodeId, result: { route: "yes" } });
    noRoute = reducer.reduceFlow(small, noRoute, { type: "node_succeeded", nodeId: "n3", result: { route: "no" } });
    reducer.flowIsTerminal(noRoute) && noRoute.nodes.n4.status === "skipped" ? pass("unreachable_skip", "inactive descendant skipped") : fail("unreachable_skip", noRoute.nodes.n4.status);
  } catch (error) { for (const id of ["fan_out_readiness", "all_success_join", "all_terminal_join", "conditional_route", "unreachable_skip"]) if (results.get(id).status === "unsupported") fail(id, error); }
}

if (contracts && nodeResult) {
  try { const node = contracts.validateGraphFlow(smallFixture()).graph.nodes[0]; nodeResult.validateNodeResult(node, { schemaVersion: "NodeResult/v1", nodeId: "n0", outcome: "success", output: { route: "yes" }, usage: { completeness: "unavailable" } }); pass("typed_result_validation", "valid result accepted"); } catch (error) { fail("typed_result_validation", error); }
  try { const node = contracts.validateGraphFlow(smallFixture()).graph.nodes[0]; nodeResult.validateNodeResult(node, { schemaVersion: "NodeResult/v1", nodeId: "n0", outcome: "success", output: { route: "invalid" }, usage: { completeness: "unavailable" } }); fail("invalid_result_fail_closed", "invalid result accepted"); } catch { pass("invalid_result_fail_closed", "invalid result rejected"); }
}
if (sessions) { try { sessions.assertSessionIsolation("flow-a", { flowId: "flow-a", sessionId: "s" }); try { sessions.assertSessionIsolation("flow-a", { flowId: "flow-b", sessionId: "s" }); fail("session_checkpoint_isolation", "cross-flow accepted"); } catch { pass("session_checkpoint_isolation", "cross-flow rejected"); } } catch (error) { fail("session_checkpoint_isolation", error); } }
if (telemetry) { try { const usage = telemetry.aggregateUsage([{ inputTokens: 10, outputTokens: 2, completeness: "exact" }, { completeness: "unavailable" }]); usage.inputTokens === 10 && usage.completeness === "partial" ? pass("usage_completeness", usage) : fail("usage_completeness", usage); } catch (error) { fail("usage_completeness", error); } }

try {
  const { createCollabMcpServer } = await importBuilt("mcp/server.js");
  const service = { status: async () => ({ capabilities: { graphFlowValidation: "flow/v1" } }), validateFlow: async () => ({ valid: true }), search: async () => [], delegate: async () => ({}), requestReview: async () => ({}), runStatus: async () => ({}), indexNow: async () => ({}) };
  const server = createCollabMcpServer(service); const client = new Client({ name: "eval", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]); const tools = await client.listTools();
  tools.tools.some((tool) => tool.name === "collab_flow_validate") ? pass("mcp_flow_capability", "collab_flow_validate registered") : fail("mcp_flow_capability", "validation tool missing");
  await client.close(); await server.close();
} catch (error) { fail("mcp_flow_capability", error); }

let fanOutSamples = [];
for (let iteration = 0; iteration < contract.iterations.fanOutWallTime; iteration += 1) {
  const started = performance.now();
  if (scheduler) await scheduler.runReadOnlyFanOut([0, 1, 2], contract.fixtures.readOnlyConcurrency, async () => new Promise((done) => setTimeout(done, contract.fixtures.branchDelayMs)));
  else for (let branch = 0; branch < contract.fixtures.branchCount; branch += 1) await new Promise((done) => setTimeout(done, contract.fixtures.branchDelayMs));
  fanOutSamples.push(performance.now() - started);
}
const fanOut = { medianMs: median(fanOutSamples), p95Ms: percentile(fanOutSamples, 0.95), samples: fanOutSamples };
const functional = [...results.values()]; const passed = functional.filter((item) => item.status === "pass").length;
const failed = functional.filter((item) => item.status === "fail").length; const unsupported = functional.filter((item) => item.status === "unsupported").length;
const report = { schemaVersion: "hybrid-flow-eval-report/v2", label, generatedAt: new Date().toISOString(), suiteId: contract.suiteId,
  contractSha256: sha256(contractPath), runnerSha256: sha256(runnerPath), runtimeRoot,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  functional: { passed, failed, unsupported, total: functional.length, verifiedCompletionRate: passed / functional.length, cases: functional },
  performance: { pureGraph100Nodes400Edges: pureGraph, fanOut3x40ms: fanOut, legacyQueue100NodeChain: await measureLegacyQueue() },
  thresholds: { pureGraphP95: typeof pureGraph.p95Ms === "number" && pureGraph.p95Ms <= contract.thresholds.pureGraphP95Ms,
    fanOutSpeedup: fanOut.medianMs > 0 ? (contract.fixtures.branchCount * contract.fixtures.branchDelayMs) / fanOut.medianMs : 0 },
  process: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed } };
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, contractSha256: report.contractSha256, runnerSha256: report.runnerSha256, functional: report.functional, performance: report.performance, thresholds: report.thresholds }, null, 2)}\n`);
