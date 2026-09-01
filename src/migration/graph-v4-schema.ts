import { createHash } from "node:crypto";
import Database from "better-sqlite3";

export const GRAPH_V4_TABLES = [
  "agent_attempt_usage", "agent_event_archive_members", "agent_event_archives",
  "agent_event_payloads", "agent_events", "agent_sessions", "agent_usage_coverage",
  "flow_mcp_idempotency", "graph_budget_reservations", "graph_budget_settlements",
  "graph_edge_evaluations", "graph_edges", "graph_flows", "graph_node_admission_intents",
  "graph_node_admissions", "graph_node_attempts", "graph_node_input_bindings",
  "graph_node_results", "graph_nodes", "plan_progress_events", "plan_progress_outbox",
  "session_memory_revisions",
] as const;

export const GRAPH_V4_REQUIRED_INDEXES = [
  "agent_events_cursor", "agent_sessions_parent", "agent_usage_attempt", "archive_flow_range",
  "flow_mcp_idempotency_status", "graph_attempts_latest", "graph_budget_flow",
  "graph_edges_source", "graph_edges_target", "graph_intents_pending", "graph_nodes_ready",
  "plan_progress_outbox_pending",
] as const;

const GRAPH_V4_TABLE_SCHEMA_SHA256 = "2b3a0f52fdbfe2e6a9ac4d2ace77423888c3d6c50787950bdaf834f978357751";
const GRAPH_V4_REQUIRED_INDEX_SHA256 = "1c38876a1730a8fc9b00d756bc81158d5bdd894099ef3b67d9470030b1539ba5";

interface SchemaObjectRow { type: string; name: string; tblName: string; sql: string | null }

const normalizedRows = (db: Database.Database, names?: readonly string[]): SchemaObjectRow[] => {
  const where = names === undefined ? "name NOT LIKE 'sqlite_%'" : `name IN (${names.map(() => "?").join(",")})`;
  return (db.prepare(`SELECT type,name,tbl_name AS tblName,sql FROM sqlite_schema
    WHERE ${where} ORDER BY type,name`).all(...(names ?? [])) as SchemaObjectRow[])
    .map((row) => ({ ...row, sql: typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : null }));
};

const rowsSha256 = (rows: readonly SchemaObjectRow[]): string => {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(`${JSON.stringify(row)}\n`);
  return digest.digest("hex");
};

export function graphV4SchemaState(state: Database.Database): "absent" | "complete_disabled" {
  const tables = normalizedRows(state, GRAPH_V4_TABLES);
  const requiredIndexes = normalizedRows(state, GRAPH_V4_REQUIRED_INDEXES);
  const graphTableSet = new Set<string>(GRAPH_V4_TABLES);
  const graphNamedObjects = normalizedRows(state).filter((row) =>
    row.name.startsWith("graph_") || graphTableSet.has(row.tblName));
  if (tables.length === 0 && requiredIndexes.length === 0 && graphNamedObjects.length === 0) return "absent";
  if (tables.length !== GRAPH_V4_TABLES.length || rowsSha256(tables) !== GRAPH_V4_TABLE_SCHEMA_SHA256 ||
      requiredIndexes.length !== GRAPH_V4_REQUIRED_INDEXES.length ||
      rowsSha256(requiredIndexes) !== GRAPH_V4_REQUIRED_INDEX_SHA256 ||
      graphNamedObjects.some((row) => row.type === "trigger" || row.type === "view")) {
    throw new Error("partial or altered graph v4 schema");
  }
  return "complete_disabled";
}

export function assertGraphV4PersistenceSchema(state: Database.Database): void {
  const version = Number(state.pragma("user_version", { simple: true }));
  if (version !== 4 || graphV4SchemaState(state) !== "complete_disabled") {
    throw new Error("graph persistence requires an exact graph-complete v4 SQLite database");
  }
}
