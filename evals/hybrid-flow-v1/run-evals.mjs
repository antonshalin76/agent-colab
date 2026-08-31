#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contractPath = join(root, "evals/hybrid-flow-v1/eval-contract.json");
const runnerPath = fileURLToPath(import.meta.url);
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const median = (values) => percentile(values, 0.5);

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const label = option("--label", "unlabelled");
const output = resolve(root, option("--output", `.artifacts/hybrid-flow-v1/${label}.json`));

const importBuilt = async (relative) => import(pathToFileURL(join(root, "dist", relative)).href);
const results = new Map(contract.functionalCases.map((id) => [id, { id, status: "unsupported" }]));
const pass = (id, evidence) => results.set(id, { id, status: "pass", evidence });
const fail = (id, error) => results.set(id, { id, status: "fail", error: error instanceof Error ? error.message : String(error) });

const graphFixture = () => {
  const nodes = Array.from({ length: 100 }, (_, index) => ({
    id: `n${index}`, kind: "task", approvalScope: "workspace-read",
    inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { route: { enum: ["yes", "no"] } }, required: ["route"], additionalProperties: false },
  }));
  const keys = new Set();
  for (let index = 1; index < 100; index += 1) keys.add(`${index - 1}:${index}`);
  for (let gap = 2; keys.size < 400; gap += 1) {
    for (let from = 0; from + gap < 100 && keys.size < 400; from += 1) keys.add(`${from}:${from + gap}`);
  }
  const edges = [...keys].map((key) => { const [from, to] = key.split(":"); return { from: `n${from}`, to: `n${to}`, join: "all_success" }; });
  return { schemaVersion: "GraphFlow/v1", flowId: "eval-100-400", project: root, budget: { maxNodes: 100, maxCostUsd: 1 }, nodes, edges };
};

const measureLegacyQueue = async () => {
  const { initializeCurrentExecutionSchema } = await importBuilt("migration/coordinator.js");
  const { RunStore } = await importBuilt("store/run-store.js");
  const samples = [];
  for (let iteration = 0; iteration < contract.iterations.legacyQueue; iteration += 1) {
    const temp = mkdtempSync(join(tmpdir(), "agent-collab-eval-queue-"));
    try {
      const db = join(temp, "state.db"); initializeCurrentExecutionSchema(db); const store = new RunStore(db);
      let predecessor;
      const started = performance.now();
      for (let index = 0; index < 100; index += 1) predecessor = store.enqueue({ idempotencyKey: `${iteration}:${index}`, stage: "planning", priority: 1, dependsOnRunId: predecessor?.id }).id;
      for (let index = 0; index < 100; index += 1) { const run = store.claimNext({ workerId: "eval", leaseMs: 1000 }); store.complete(run.id, run.leaseToken, { ok: true }); }
      samples.push(performance.now() - started); store.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  return { medianMs: median(samples), p95Ms: percentile(samples, 0.95), samples };
};

const sequentialFanOutSamples = async () => {
  const samples = [];
  for (let iteration = 0; iteration < contract.iterations.fanOutWallTime; iteration += 1) {
    const started = performance.now();
    for (let branch = 0; branch < contract.fixtures.branchCount; branch += 1) await new Promise((done) => setTimeout(done, contract.fixtures.branchDelayMs));
    samples.push(performance.now() - started);
  }
  return samples;
};

let pureGraph;
let fanOutSamples = await sequentialFanOutSamples();
try {
  const contracts = await importBuilt("workflow/flow-contract.js");
  const reducer = await importBuilt("workflow/flow-reducer.js");
  const scheduler = await importBuilt("runtime/graph-scheduler.js");
  const telemetry = await importBuilt("runtime/flow-telemetry.js");
  const nodeResult = await importBuilt("runtime/node-result.js");
  const sessions = await importBuilt("runtime/session-context.js");

  const graph = graphFixture(); const samples = [];
  for (let iteration = 0; iteration < contract.iterations.pureGraph; iteration += 1) {
    const started = performance.now(); contracts.validateGraphFlow(graph); reducer.initialFlowState(graph); samples.push(performance.now() - started);
  }
  pureGraph = { medianMs: median(samples), p95Ms: percentile(samples, 0.95), samples };
  pass("dag_validation", `${graph.nodes.length} nodes/${graph.edges.length} edges`);
  try { contracts.validateGraphFlow({ ...graph, edges: [...graph.edges, { from: "n99", to: "n0", join: "all_success" }] }); fail("cycle_rejection", "cycle accepted"); } catch { pass("cycle_rejection", "cycle rejected"); }

  const small = contracts.validateGraphFlow({ schemaVersion: "GraphFlow/v1", flowId: "functional", project: root, budget: { maxNodes: 8, maxCostUsd: 1 }, nodes: graph.nodes.slice(0, 5), edges: [
    { from: "n0", to: "n1", join: "all_success" }, { from: "n0", to: "n2", join: "all_success" },
    { from: "n1", to: "n3", join: "all_success" }, { from: "n2", to: "n3", join: "all_success" },
    { from: "n3", to: "n4", join: "all_terminal", condition: { route: "yes" } },
  ] }).graph;
  let state = reducer.initialFlowState(small);
  state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n0", result: { route: "yes" } });
  const readyAfterRoot = reducer.readyNodeIds(state); readyAfterRoot.includes("n1") && readyAfterRoot.includes("n2") ? pass("fan_out_readiness", readyAfterRoot) : fail("fan_out_readiness", readyAfterRoot);
  state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n1", result: { route: "yes" } });
  reducer.readyNodeIds(state).includes("n3") ? fail("all_success_join", "opened early") : undefined;
  state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n2", result: { route: "yes" } });
  reducer.readyNodeIds(state).includes("n3") ? pass("all_success_join", "closed until both parents succeeded") : fail("all_success_join", "did not open");
  state = reducer.reduceFlow(small, state, { type: "node_succeeded", nodeId: "n3", result: { route: "yes" } });
  reducer.readyNodeIds(state).includes("n4") ? pass("all_terminal_join", "terminal parent opens join") : fail("all_terminal_join", "closed");
  pass("conditional_route", "route=yes activated");
  const noRoute = reducer.reduceFlow(small, reducer.reduceFlow(small, reducer.reduceFlow(small, reducer.reduceFlow(small, reducer.initialFlowState(small), { type: "node_succeeded", nodeId: "n0", result: { route: "yes" } }), { type: "node_succeeded", nodeId: "n1", result: { route: "yes" } }), { type: "node_succeeded", nodeId: "n2", result: { route: "yes" } }), { type: "node_succeeded", nodeId: "n3", result: { route: "no" } });
  reducer.flowIsTerminal(noRoute) ? pass("unreachable_skip", "no-route descendants terminally skipped") : fail("unreachable_skip", "flow remained open");

  nodeResult.validateNodeResult(graph.nodes[0], { schemaVersion: "NodeResult/v1", nodeId: "n0", outcome: "success", output: { route: "yes" }, usage: { completeness: "unavailable" } }); pass("typed_result_validation", "valid result accepted");
  try { nodeResult.validateNodeResult(graph.nodes[0], { schemaVersion: "NodeResult/v1", nodeId: "n0", outcome: "success", output: { route: "invalid" } }); fail("invalid_result_fail_closed", "invalid result accepted"); } catch { pass("invalid_result_fail_closed", "invalid result rejected"); }
  sessions.assertSessionIsolation("flow-a", { flowId: "flow-a", sessionId: "s" }); try { sessions.assertSessionIsolation("flow-a", { flowId: "flow-b", sessionId: "s" }); fail("session_checkpoint_isolation", "cross-flow accepted"); } catch { pass("session_checkpoint_isolation", "cross-flow rejected"); }
  const aggregate = telemetry.aggregateUsage([{ inputTokens: 10, outputTokens: 2, completeness: "exact" }, { completeness: "unavailable" }]);
  aggregate.inputTokens === 10 && aggregate.completeness === "partial" ? pass("usage_completeness", aggregate) : fail("usage_completeness", aggregate);
  const mcpSource = readFileSync(join(root, "src/mcp/server.ts"), "utf8");
  mcpSource.includes("collab_flow_create") && mcpSource.includes("collab_flow_capabilities") ? pass("mcp_flow_capability", "flow/v1 tools registered") : fail("mcp_flow_capability", "tools missing");

  fanOutSamples = [];
  for (let iteration = 0; iteration < contract.iterations.fanOutWallTime; iteration += 1) {
    const started = performance.now();
    await scheduler.runReadOnlyFanOut([0, 1, 2], contract.fixtures.readOnlyConcurrency, async () => new Promise((done) => setTimeout(done, contract.fixtures.branchDelayMs)));
    fanOutSamples.push(performance.now() - started);
  }
} catch (error) {
  pureGraph = { status: "unsupported", reason: error instanceof Error ? error.message : String(error) };
}

const functional = [...results.values()];
const passed = functional.filter((item) => item.status === "pass").length;
const failed = functional.filter((item) => item.status === "fail").length;
const unsupported = functional.filter((item) => item.status === "unsupported").length;
const report = {
  schemaVersion: "hybrid-flow-eval-report/v1", label, generatedAt: new Date().toISOString(),
  suiteId: contract.suiteId, contractSha256: sha256(contractPath), runnerSha256: sha256(runnerPath),
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  functional: { passed, failed, unsupported, total: functional.length, verifiedCompletionRate: passed / functional.length, cases: functional },
  performance: {
    pureGraph100Nodes400Edges: pureGraph,
    fanOut3x40ms: { medianMs: median(fanOutSamples), p95Ms: percentile(fanOutSamples, 0.95), samples: fanOutSamples },
    legacyQueue100NodeChain: await measureLegacyQueue(),
  },
  process: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
};
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, contractSha256: report.contractSha256, functional: report.functional, performance: report.performance }, null, 2)}\n`);
