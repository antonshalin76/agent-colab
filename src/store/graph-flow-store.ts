import Database from "better-sqlite3";
import { assertGraphV4PersistenceSchema } from "../migration/graph-v4-schema.js";
import { openStateStoreAccess, type StateDatabaseAccess, type StateStoreInput } from "./state-database-fence.js";

import {
  canonicalJson,
  computeJsonSha256,
  validateGraphFlow,
  type GraphFlow,
} from "../workflow/flow-contract.js";

export interface GraphFlowSubmission {
  definition: unknown;
  requester: string;
  now?: number;
}

export interface GraphFlowSubmissionResult {
  flowId: string;
  definitionSha256: string;
  status: "submitted";
  replayed: boolean;
}

export interface GraphFlowStoreOptions {
  faultInjector?: (point: "after_write_admission" | "before_edge_insert") => void;
}

interface FlowRow {
  flow_id: string;
  project: string;
  origin: string;
  requester: string;
  definition_json: string;
  definition_sha256: string;
  token_ceiling: number;
  cost_ceiling_microusd: number | null;
}

interface DefinitionRow {
  id: string;
  definition_json: string;
  definition_sha256: string;
}

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  condition_json: string;
  condition_sha256: string;
  join_policy: string;
}

function canonicalNodeRows(graph: GraphFlow): DefinitionRow[] {
  return graph.nodes.map((node) => ({
    id: node.nodeId,
    definition_json: canonicalJson(node),
    definition_sha256: computeJsonSha256(node),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalEdgeRows(graph: GraphFlow): EdgeRow[] {
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  return graph.edges.map((edge) => ({
    id: edge.edgeId,
    source_id: edge.sourceId,
    target_id: edge.targetId,
    condition_json: canonicalJson(edge.condition),
    condition_sha256: computeJsonSha256(edge.condition),
    join_policy: nodes.get(edge.targetId)!.joinPolicy,
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function immutableFlowMatches(row: FlowRow, graph: GraphFlow, requester: string, definitionJson: string): boolean {
  return row.flow_id === graph.flowId && row.project === graph.project && row.origin === graph.origin &&
    row.requester === requester && row.definition_json === definitionJson &&
    row.definition_sha256 === graph.definitionSha256 && row.token_ceiling === graph.budget.maxTokens &&
    row.cost_ceiling_microusd === (graph.budget.maxCostMicrousd ?? null);
}

export class GraphFlowStore {
  private readonly db: Database.Database;
  private readonly access!: StateDatabaseAccess;
  private closeAccess: () => void = () => {};

  constructor(databasePath: StateStoreInput, private readonly options: GraphFlowStoreOptions = {}) {
    try {
      const opened = openStateStoreAccess(databasePath);
      this.access = opened.access;
      this.closeAccess = opened.close;
      this.db = this.access.database;
      assertGraphV4PersistenceSchema(this.db);
      this.access.assertUsable();
    } catch (error) {
      this.closeAccess();
      if (error instanceof Error && /state database|state root|graph database|graph-complete v4/u.test(error.message)) throw error;
      throw new Error("GraphFlowStore requires an existing graph-complete v4 SQLite database", { cause: error });
    }
  }

  submit(input: GraphFlowSubmission): GraphFlowSubmissionResult {
    const { graph } = validateGraphFlow(input.definition);
    if (input.requester.length === 0) throw new Error("graph flow requester is required");
    const now = input.now ?? Date.now();
    const deadline = now + graph.budget.maxWallTimeMs;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline)) {
      throw new Error("graph flow submission time is outside the safe integer range");
    }
    const definitionJson = canonicalJson(graph);
    const nodeRows = canonicalNodeRows(graph);
    const edgeRows = canonicalEdgeRows(graph);

    this.access.assertUsable();
      this.options.faultInjector?.("after_write_admission");
    return this.db.transaction((): GraphFlowSubmissionResult => {
      const existing = this.db.prepare(`SELECT flow_id,project,origin,requester,definition_json,
        definition_sha256,token_ceiling,cost_ceiling_microusd FROM graph_flows WHERE flow_id=?`)
        .get(graph.flowId) as FlowRow | undefined;
      if (existing) {
        if (!immutableFlowMatches(existing, graph, input.requester, definitionJson) ||
            canonicalJson(this.readNodeRows(this.db, graph.flowId)) !== canonicalJson(nodeRows) ||
            canonicalJson(this.readEdgeRows(this.db, graph.flowId)) !== canonicalJson(edgeRows)) {
          throw new Error("flow id conflicts with immutable graph definition");
        }
        return {
          flowId: graph.flowId,
          definitionSha256: graph.definitionSha256,
          status: "submitted",
          replayed: true,
        };
      }

      const hashOwner = this.db.prepare(`SELECT flow_id FROM graph_flows
        WHERE project=? AND definition_sha256=?`).pluck().get(graph.project, graph.definitionSha256) as string | undefined;
      if (hashOwner !== undefined) {
        throw new Error("project and definition hash conflict with another flow id");
      }

      this.db.prepare(`INSERT INTO graph_flows
        (flow_id,project,origin,requester,definition_json,definition_sha256,status,
         token_ceiling,cost_ceiling_microusd,deadline_at,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'submitted',?,?,?,1,?,?)`).run(
          graph.flowId,
          graph.project,
          graph.origin,
          input.requester,
          definitionJson,
          graph.definitionSha256,
          graph.budget.maxTokens,
          graph.budget.maxCostMicrousd ?? null,
          deadline,
          now,
          now,
        );
      const insertNode = this.db.prepare(`INSERT INTO graph_nodes
        (flow_id,node_id,definition_json,definition_sha256,status,ready_revision,version,updated_at)
        VALUES (?,?,?,?,'pending',0,1,?)`);
      for (const [node, row] of graph.nodes.map((node) => [node, nodeRows.find(({ id }) => id === node.nodeId)!] as const)) {
        insertNode.run(graph.flowId, node.nodeId, row.definition_json, row.definition_sha256, now);
      }
      const insertEdge = this.db.prepare(`INSERT INTO graph_edges
        (flow_id,edge_id,source_id,target_id,condition_json,condition_sha256,join_policy)
        VALUES (?,?,?,?,?,?,?)`);
      for (const edge of edgeRows) {
        this.options.faultInjector?.("before_edge_insert");
        insertEdge.run(graph.flowId, edge.id, edge.source_id, edge.target_id,
          edge.condition_json, edge.condition_sha256, edge.join_policy);
      }
      return {
        flowId: graph.flowId,
        definitionSha256: graph.definitionSha256,
        status: "submitted",
        replayed: false,
      };
    }).immediate();
  }

  private readNodeRows(db: Database.Database, flowId: string): DefinitionRow[] {
    return db.prepare(`SELECT node_id AS id,definition_json,definition_sha256
      FROM graph_nodes WHERE flow_id=? ORDER BY node_id`).all(flowId) as DefinitionRow[];
  }

  private readEdgeRows(db: Database.Database, flowId: string): EdgeRow[] {
    return db.prepare(`SELECT edge_id AS id,source_id,target_id,condition_json,condition_sha256,join_policy
      FROM graph_edges WHERE flow_id=? ORDER BY edge_id`).all(flowId) as EdgeRow[];
  }

  close(): void { this.closeAccess(); }
}
