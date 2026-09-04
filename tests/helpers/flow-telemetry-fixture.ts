import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { initializeCurrentExecutionSchema } from "../../src/migration/coordinator.js";
import { GraphFlowStore } from "../../src/store/graph-flow-store.js";
import {
  canonicalJson,
  computeGraphDefinitionSha256,
  computeJsonSha256,
} from "../../src/workflow/flow-contract.js";
import { createCollaborationRun, serializeCollaborationRun } from "../../src/workflow/workflow.js";

export interface TelemetryFixture {
  readonly root: string;
  readonly databasePath: string;
}

export interface SeedAttemptInput {
  readonly attemptId: string;
  readonly flowId: "flow-a" | "flow-b";
  readonly nodeId: "node-a" | "node-b" | "node-c" | "node-other";
  readonly attemptNo: number;
  readonly workflowId: string;
  readonly sessionId: string;
  readonly createdAt?: number;
}

const graphNode = (nodeId: string, stageKind: "coordination" | "implementation") => ({
  nodeId,
  stageKind,
  role: stageKind === "coordination" ? "coordinator" : "stage-owner",
  approvalScope: "workspace-read",
  promptTemplateRef: `prompt:${nodeId}`,
  artifactRef: `artifact:${nodeId}`,
  inputPorts: [],
  outputSchema: {
    type: "object",
    properties: { complete: { type: "boolean" } },
    required: ["complete"],
    additionalProperties: false,
  },
  joinPolicy: "all_success",
  allowedRoutes: [],
  timeoutMs: 30_000,
  maxAttempts: 2,
  requestedTokenLimit: 1_000,
});

const graphDefinition = (flowId: string, nodes: readonly string[]) => {
  const value = {
    schemaVersion: "GraphFlow/v1",
    flowId,
    taskId: `task:${flowId}`,
    project: `/project/${flowId}`,
    origin: "codex",
    budget: {
      maxNodes: 8,
      maxActiveReadOnly: 2,
      maxChildDepth: 4,
      maxTokens: 100_000,
      maxWallTimeMs: 1_000_000,
      maxCostMicrousd: 1_000_000,
    },
    nodes: nodes.map((nodeId, index) => graphNode(nodeId, index === 0 ? "coordination" : "implementation")),
    edges: nodes.slice(1).map((nodeId) => ({
      edgeId: `${nodes[0]}-${nodeId}`,
      sourceId: nodes[0]!,
      targetId: nodeId,
      condition: { kind: "outcome", outcomes: ["succeeded"] },
    })),
  };
  return { ...value, definitionSha256: computeGraphDefinitionSha256(value) };
};

const workflowState = (workflowId: string): string => serializeCollaborationRun(createCollaborationRun({
  taskId: `task:${workflowId}`,
  origin: "codex",
  health: { codex: "healthy", grok: "unavailable" },
  stages: [{
    id: `stage:${workflowId}`,
    kind: "tdd_coding",
    role: "stage-owner",
    artifactRef: `artifact:${workflowId}`,
    artifactHash: "a".repeat(64),
    artifactBytes: 1,
    changedFiles: 0,
    approvalScope: "workspace-read",
    idempotencyKey: `idempotency:${workflowId}`,
    mapLearning: {
      schemaVersion: "map-learning-launch-binding/v1",
      consumer: "codex",
      projectionBase64: "",
      digest: "b".repeat(64),
    },
  }],
  now: 1_000,
}));

function insertAttempt(db: Database.Database, input: SeedAttemptInput): void {
  db.prepare(`INSERT INTO collaboration_runs
    (workflow_id,state_json,version,updated_at) VALUES (?,?,1,?)`).run(
      input.workflowId,
      workflowState(input.workflowId),
      input.createdAt ?? 1_000,
    );
  db.prepare(`INSERT INTO graph_node_attempts
    (attempt_id,flow_id,node_id,attempt_no,workflow_id,run_id,session_id,status,created_at,terminal_at)
    VALUES (?,?,?,?,?,NULL,?,'running',?,NULL)`).run(
      input.attemptId,
      input.flowId,
      input.nodeId,
      input.attemptNo,
      input.workflowId,
      input.sessionId,
      input.createdAt ?? 1_000,
    );
}

function insertGraphResult(
  db: Database.Database,
  input: {
    resultId: string;
    flowId: string;
    nodeId: string;
    attemptId: string | null;
    attemptNo: number;
    outcome: "succeeded" | "failed" | "cancelled" | "skipped";
    createdAt: number;
  },
): void {
  const terminalEnvelope = {
    schemaVersion: "GraphNodeTerminalEnvelope/v1",
    flowId: input.flowId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    outcome: input.outcome,
    createdAt: input.createdAt,
  };
  const output = input.outcome === "succeeded" ? { complete: true } : null;
  db.prepare(`INSERT OR IGNORE INTO graph_node_results
    (result_id,flow_id,node_id,attempt_id,attempt_no,outcome,terminal_envelope_json,
     terminal_envelope_sha256,result_json,result_sha256,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.resultId,
      input.flowId,
      input.nodeId,
      input.attemptId,
      input.attemptNo,
      input.outcome,
      canonicalJson(terminalEnvelope),
      computeJsonSha256(terminalEnvelope),
      output === null ? null : canonicalJson(output),
      output === null ? null : computeJsonSha256(output),
      input.createdAt,
    );
}

function succeedRootAndActivateDescendants(db: Database.Database, now: number): void {
  const root = db.prepare(`SELECT status,terminal_at FROM graph_node_attempts
    WHERE flow_id='flow-a' AND node_id='node-a' AND attempt_no=1`).get() as {
      status: string;
      terminal_at: number | null;
    } | undefined;
  if (!root) throw new Error("fixture root attempt is missing");
  if (root.status === "running") {
    db.prepare(`UPDATE graph_node_attempts SET status='succeeded',terminal_at=?
      WHERE flow_id='flow-a' AND node_id='node-a' AND attempt_no=1 AND status='running'`).run(now);
  } else if (root.status !== "succeeded") {
    throw new Error("fixture descendants require a succeeded root attempt");
  }

  insertGraphResult(db, {
    resultId: "result:attempt-a",
    flowId: "flow-a",
    nodeId: "node-a",
    attemptId: "attempt-a",
    attemptNo: 1,
    outcome: "succeeded",
    createdAt: root.terminal_at ?? now,
  });
  db.prepare(`UPDATE graph_nodes SET status='succeeded',updated_at=?
    WHERE flow_id='flow-a' AND node_id='node-a'`).run(root.terminal_at ?? now);

  const insertEvaluation = db.prepare(`INSERT OR IGNORE INTO graph_edge_evaluations
    (flow_id,edge_id,source_attempt_no,decision,envelope_sha256,evaluator_version,created_at)
    VALUES ('flow-a',?,1,'activated',?,'fixture-v1',?)`);
  for (const nodeId of ["node-b", "node-c"] as const) {
    const edgeId = `node-a-${nodeId}`;
    const evaluation = {
      schemaVersion: "GraphEdgeEvaluation/v1",
      flowId: "flow-a",
      edgeId,
      sourceAttemptNo: 1,
      decision: "activated",
    };
    insertEvaluation.run(edgeId, computeJsonSha256(evaluation), root.terminal_at ?? now);
    db.prepare(`UPDATE graph_nodes SET status='ready',ready_revision=CASE
      WHEN ready_revision=0 THEN 1 ELSE ready_revision END,updated_at=?
      WHERE flow_id='flow-a' AND node_id=? AND status IN ('pending','ready')`).run(
        root.terminal_at ?? now,
        nodeId,
      );
  }
}

function projectFailedRoot(
  db: Database.Database,
  input: { attemptId: string; attemptNo: number; status: "failed" | "cancelled"; terminalAt: number },
): void {
  insertGraphResult(db, {
    resultId: `result:${input.attemptId}`,
    flowId: "flow-a",
    nodeId: "node-a",
    attemptId: input.attemptId,
    attemptNo: input.attemptNo,
    outcome: input.status,
    createdAt: input.terminalAt,
  });
  const insertEvaluation = db.prepare(`INSERT OR IGNORE INTO graph_edge_evaluations
    (flow_id,edge_id,source_attempt_no,decision,envelope_sha256,evaluator_version,created_at)
    VALUES ('flow-a',?,?,'inactive',?,'fixture-v1',?)`);
  for (const nodeId of ["node-b", "node-c"] as const) {
    const edgeId = `node-a-${nodeId}`;
    const evaluation = {
      schemaVersion: "GraphEdgeEvaluation/v1",
      flowId: "flow-a",
      edgeId,
      sourceAttemptNo: input.attemptNo,
      decision: "inactive",
    };
    insertEvaluation.run(edgeId, input.attemptNo, computeJsonSha256(evaluation), input.terminalAt);
    db.prepare(`UPDATE graph_nodes SET status='skipped',updated_at=?
      WHERE flow_id='flow-a' AND node_id=? AND status IN ('pending','ready')`).run(input.terminalAt, nodeId);
    insertGraphResult(db, {
      resultId: `result:skipped:${nodeId}`,
      flowId: "flow-a",
      nodeId,
      attemptId: null,
      attemptNo: 0,
      outcome: "skipped",
      createdAt: input.terminalAt,
    });
  }
  db.prepare(`UPDATE graph_flows SET status=?,updated_at=? WHERE flow_id='flow-a'`)
    .run(input.status, input.terminalAt);
}

function prepareRetry(db: Database.Database, input: SeedAttemptInput): void {
  const previous = db.prepare(`SELECT attempt_id,status,terminal_at FROM graph_node_attempts
    WHERE flow_id=? AND node_id=? AND attempt_no=?`).get(
      input.flowId,
      input.nodeId,
      input.attemptNo - 1,
    ) as { attempt_id: string; status: string; terminal_at: number | null } | undefined;
  if (!previous) throw new Error("fixture retry requires its preceding attempt");
  const retryReadyAt = input.createdAt ?? 1_000;
  if (previous.status === "running") {
    db.prepare(`UPDATE graph_node_attempts SET status='failed',terminal_at=? WHERE attempt_id=? AND status='running'`)
      .run(Math.min(retryReadyAt - 1, 1_400), previous.attempt_id);
  } else if (!(["failed", "cancelled"] as const).includes(previous.status as "failed" | "cancelled")) {
    throw new Error("fixture retry requires a failed or cancelled preceding attempt");
  }
  db.prepare(`UPDATE graph_nodes SET status='ready',ready_revision=ready_revision+1,updated_at=?
    WHERE flow_id=? AND node_id=?`).run(retryReadyAt, input.flowId, input.nodeId);
}

export function createTelemetryFixture(): TelemetryFixture {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-telemetry-v4-"));
  mkdirSync(join(root, "state"));
  const databasePath = join(root, "state", "collaboration.db");
  initializeCurrentExecutionSchema(databasePath);
  for (const definition of [
    graphDefinition("flow-a", ["node-a", "node-b", "node-c"]),
    graphDefinition("flow-b", ["node-other"]),
  ]) {
    const graphStore = new GraphFlowStore(databasePath);
    try { graphStore.submit({ definition, requester: "tester", now: 1_000 }); }
    finally { graphStore.close(); }
  }
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => {
      db.prepare("UPDATE graph_flows SET status='running',updated_at=1000").run();
      db.prepare("UPDATE graph_nodes SET status='pending',ready_revision=0,updated_at=1000").run();
      for (const input of [
        { attemptId: "attempt-a", flowId: "flow-a", nodeId: "node-a", attemptNo: 1,
          workflowId: "workflow-a", sessionId: "session-a" },
        { attemptId: "attempt-other", flowId: "flow-b", nodeId: "node-other", attemptNo: 1,
          workflowId: "workflow-other", sessionId: "session-other" },
      ] as const) {
        insertAttempt(db, input);
        db.prepare("UPDATE graph_nodes SET status='running',ready_revision=1,updated_at=1000 WHERE flow_id=? AND node_id=?")
          .run(input.flowId, input.nodeId);
      }
    }).immediate();
  } finally {
    db.close();
  }
  assertValidGraphLifecycle(databasePath);
  return { root, databasePath };
}

export function assertValidGraphLifecycle(databasePath: string): void {
  const db = new Database(databasePath, { readonly: true });
  try {
    const attempts = db.prepare(`SELECT a.flow_id,a.node_id,a.attempt_id,a.attempt_no,a.status,
      a.created_at,a.terminal_at,n.status AS node_status
      FROM graph_node_attempts a JOIN graph_nodes n USING(flow_id,node_id)
      ORDER BY a.flow_id,a.node_id,a.attempt_no`).all() as Array<{
        flow_id: string;
        node_id: string;
        attempt_id: string;
        attempt_no: number;
        status: string;
        created_at: number;
        terminal_at: number | null;
        node_status: string;
      }>;
    const groups = new Map<string, typeof attempts>();
    for (const attempt of attempts) {
      const key = `${attempt.flow_id}\u0000${attempt.node_id}`;
      const group = groups.get(key) ?? [];
      group.push(attempt);
      groups.set(key, group);
      const terminal = ["succeeded", "failed", "cancelled"].includes(attempt.status);
      if (terminal !== (attempt.terminal_at !== null)) {
        throw new Error(`fixture attempt ${attempt.attempt_id} has inconsistent terminal state`);
      }
    }
    for (const group of groups.values()) {
      if (group.filter(({ status }) => status === "running").length > 1) {
        throw new Error("fixture contains simultaneous running attempts for one node");
      }
      for (let index = 1; index < group.length; index += 1) {
        const previous = group[index - 1]!;
        const current = group[index]!;
        if (previous.terminal_at === null || previous.terminal_at > current.created_at ||
            current.attempt_no !== previous.attempt_no + 1) {
          throw new Error("fixture retry chronology is invalid");
        }
      }
      const latest = group.at(-1)!;
      if (latest.node_status !== latest.status) {
        throw new Error(`fixture node ${latest.node_id} disagrees with its latest attempt`);
      }
    }

    const invalidDescendant = db.prepare(`SELECT a.attempt_id FROM graph_node_attempts a
      JOIN graph_edges e ON e.flow_id=a.flow_id AND e.target_id=a.node_id
      LEFT JOIN graph_edge_evaluations x ON x.flow_id=e.flow_id AND x.edge_id=e.edge_id
      LEFT JOIN graph_node_results r ON r.flow_id=e.flow_id AND r.node_id=e.source_id
      WHERE x.decision IS NOT 'activated' OR r.outcome IS NOT 'succeeded'
         OR x.created_at>a.created_at OR r.created_at>a.created_at LIMIT 1`).pluck().get();
    if (invalidDescendant !== undefined) {
      throw new Error(`fixture descendant ${String(invalidDescendant)} lacks an activated successful predecessor`);
    }

    const terminalEdges = db.prepare(`SELECT n.status AS source_status,a.attempt_no,e.edge_id,
      x.decision,t.status AS target_status
      FROM graph_nodes n
      JOIN graph_node_attempts a ON a.flow_id=n.flow_id AND a.node_id=n.node_id
       AND a.attempt_no=(SELECT MAX(z.attempt_no) FROM graph_node_attempts z
         WHERE z.flow_id=n.flow_id AND z.node_id=n.node_id)
      JOIN graph_edges e ON e.flow_id=n.flow_id AND e.source_id=n.node_id
      JOIN graph_nodes t ON t.flow_id=e.flow_id AND t.node_id=e.target_id
      LEFT JOIN graph_edge_evaluations x ON x.flow_id=e.flow_id AND x.edge_id=e.edge_id
       AND x.source_attempt_no=a.attempt_no
      WHERE n.status IN ('succeeded','failed','cancelled')`).all() as Array<{
        source_status: string;
        attempt_no: number;
        edge_id: string;
        decision: string | null;
        target_status: string;
      }>;
    for (const edge of terminalEdges) {
      const succeeds = edge.source_status === "succeeded";
      if ((succeeds && edge.decision !== "activated") || (!succeeds && edge.decision !== "inactive") ||
          (succeeds && !["ready", "running", "succeeded", "failed", "cancelled"].includes(edge.target_status)) ||
          (!succeeds && edge.target_status !== "skipped")) {
        throw new Error(`fixture terminal edge ${edge.edge_id} lacks its complete projection`);
      }
    }
  } finally {
    db.close();
  }
}

export function seedGraphAttempt(databasePath: string, input: SeedAttemptInput): void {
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => {
      const effectiveInput: SeedAttemptInput = input.createdAt === undefined && input.flowId === "flow-a" &&
        (input.nodeId === "node-b" || input.nodeId === "node-c")
        ? { ...input, createdAt: 1_200 }
        : input;
      if (input.flowId === "flow-a" && (input.nodeId === "node-b" || input.nodeId === "node-c")) {
        succeedRootAndActivateDescendants(db, 1_100);
      } else if (input.attemptNo > 1) {
        prepareRetry(db, effectiveInput);
      } else {
        throw new Error("fixture may seed only an activated descendant or a lifecycle-valid retry");
      }
      insertAttempt(db, effectiveInput);
      const changed = db.prepare("UPDATE graph_nodes SET status='running',updated_at=? WHERE flow_id=? AND node_id=? AND status='ready'")
        .run(effectiveInput.createdAt ?? 1_000, effectiveInput.flowId, effectiveInput.nodeId);
      if (changed.changes !== 1) throw new Error("fixture attempt requires exactly one ready node");
    }).immediate();
  }
  finally { db.close(); }
  assertValidGraphLifecycle(databasePath);
}

export function terminalizeGraphAttempt(
  databasePath: string,
  input: { flowId: string; nodeId: string; attemptId: string; status: "succeeded" | "failed" | "cancelled"; terminalAt: number },
): void {
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  try {
    db.transaction(() => {
      const changed = db.prepare(`UPDATE graph_node_attempts SET status=?,terminal_at=?
        WHERE flow_id=? AND node_id=? AND attempt_id=? AND status='running'`).run(
          input.status, input.terminalAt, input.flowId, input.nodeId, input.attemptId,
        );
      if (changed.changes !== 1) throw new Error("fixture attempt terminal transition did not match one running attempt");
      const latestAttemptId = db.prepare(`SELECT attempt_id FROM graph_node_attempts
        WHERE flow_id=? AND node_id=? ORDER BY attempt_no DESC LIMIT 1`).pluck().get(
          input.flowId,
          input.nodeId,
        );
      if (latestAttemptId === input.attemptId) {
        db.prepare(`UPDATE graph_nodes SET status=?,updated_at=? WHERE flow_id=? AND node_id=?`)
          .run(input.status, input.terminalAt, input.flowId, input.nodeId);
        if (input.flowId === "flow-a" && input.nodeId === "node-a") {
          const attemptNo = db.prepare("SELECT attempt_no FROM graph_node_attempts WHERE attempt_id=?")
            .pluck().get(input.attemptId) as number;
          if (input.status === "succeeded") succeedRootAndActivateDescendants(db, input.terminalAt);
          else projectFailedRoot(db, {
            attemptId: input.attemptId,
            attemptNo,
            status: input.status,
            terminalAt: input.terminalAt,
          });
        }
      }
    }).immediate();
  } finally { db.close(); }
  assertValidGraphLifecycle(databasePath);
}

export function telemetryRows(databasePath: string): Record<string, Array<Record<string, unknown>>> {
  const db = new Database(databasePath, { readonly: true });
  try {
    return Object.fromEntries([
      "collaboration_runs",
      "collaboration_dispatch_outbox",
      "runs",
      "graph_flows",
      "graph_nodes",
      "graph_edges",
      "graph_edge_evaluations",
      "graph_node_admission_intents",
      "graph_node_attempts",
      "graph_node_admissions",
      "graph_node_input_bindings",
      "graph_node_results",
      "graph_budget_reservations",
      "graph_budget_settlements",
      "agent_sessions",
      "session_memory_revisions",
      "agent_events",
      "agent_event_payloads",
      "agent_attempt_usage",
      "agent_usage_coverage",
      "agent_event_archives",
      "agent_event_archive_members",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) as Record<
      string,
      Array<Record<string, unknown>>
    >;
  } finally {
    db.close();
  }
}
