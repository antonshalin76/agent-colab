-- Normative additive SQLite schema for agent-collab-hybrid-flow-v1@1.0.1.
-- Existing v3 tables are not repeated. Application APIs MUST NOT update or
-- delete immutable ledger rows. All timestamps are Unix milliseconds.

CREATE TABLE graph_flows (
  flow_id TEXT PRIMARY KEY, project TEXT NOT NULL, origin TEXT NOT NULL,
  requester TEXT NOT NULL, definition_json TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
  ('submitted','running','succeeded','failed','cancelled','needs_reconciliation')),
  token_ceiling INTEGER NOT NULL CHECK(token_ceiling>=0),
  cost_ceiling_microusd INTEGER CHECK(cost_ceiling_microusd>=0),
  deadline_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(project,definition_sha256)
);

CREATE TABLE graph_nodes (
  flow_id TEXT NOT NULL, node_id TEXT NOT NULL, definition_json TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
  ('pending','ready','awaiting_authority','admitting','queued','running','succeeded',
   'failed','cancelled','skipped','blocked','needs_reconciliation')),
  ready_revision INTEGER NOT NULL DEFAULT 0 CHECK(ready_revision>=0),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at INTEGER NOT NULL,
  PRIMARY KEY(flow_id,node_id),
  FOREIGN KEY(flow_id) REFERENCES graph_flows(flow_id) ON DELETE RESTRICT
);

CREATE TABLE graph_edges (
  flow_id TEXT NOT NULL, edge_id TEXT NOT NULL, source_id TEXT NOT NULL,
  target_id TEXT NOT NULL, condition_json TEXT NOT NULL,
  condition_sha256 TEXT NOT NULL, join_policy TEXT NOT NULL
    CHECK(join_policy IN ('all_success','all_terminal')),
  PRIMARY KEY(flow_id,edge_id),
  UNIQUE(flow_id,source_id,target_id,condition_sha256),
  FOREIGN KEY(flow_id,source_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,target_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT
);

CREATE TABLE graph_edge_evaluations (
  flow_id TEXT NOT NULL, edge_id TEXT NOT NULL, source_attempt_no INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('activated','inactive')),
  envelope_sha256 TEXT NOT NULL, evaluator_version TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(flow_id,edge_id,source_attempt_no),
  FOREIGN KEY(flow_id,edge_id) REFERENCES graph_edges(flow_id,edge_id) ON DELETE RESTRICT
);

CREATE TABLE graph_node_admission_intents (
  flow_id TEXT NOT NULL, node_id TEXT NOT NULL, ready_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN
  ('pending','claimed','admitted','stale','cancelled','budget_blocked')),
  intent_sha256 TEXT NOT NULL, lease_owner TEXT, lease_expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at INTEGER NOT NULL,
  PRIMARY KEY(flow_id,node_id,ready_revision),
  FOREIGN KEY(flow_id,node_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT
);

CREATE TABLE graph_node_attempts (
  attempt_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no>0), workflow_id TEXT NOT NULL,
  run_id TEXT, session_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
  ('admitted','queued','running','succeeded','failed','cancelled','stale_after_admission','needs_reconciliation')),
  created_at INTEGER NOT NULL, terminal_at INTEGER,
  UNIQUE(flow_id,node_id,attempt_no), UNIQUE(flow_id,attempt_id),
  UNIQUE(flow_id,node_id,attempt_id),
  UNIQUE(flow_id,node_id,attempt_id,attempt_no), UNIQUE(workflow_id),
  FOREIGN KEY(flow_id,node_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY(workflow_id) REFERENCES collaboration_runs(workflow_id) ON DELETE RESTRICT
);

CREATE TABLE graph_node_admissions (
  admission_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL, ready_revision INTEGER NOT NULL,
  admission_json TEXT NOT NULL, admission_sha256 TEXT NOT NULL UNIQUE,
  approval_consumption_key TEXT, created_at INTEGER NOT NULL,
  UNIQUE(flow_id,node_id,attempt_no),
  FOREIGN KEY(flow_id,node_id,attempt_no)
    REFERENCES graph_node_attempts(flow_id,node_id,attempt_no) ON DELETE RESTRICT
);

CREATE TABLE graph_node_input_bindings (
  flow_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  port_name TEXT NOT NULL, source_node_id TEXT NOT NULL,
  terminal_envelope_sha256 TEXT NOT NULL, binding_json TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL, PRIMARY KEY(flow_id,node_id,attempt_no,port_name),
  FOREIGN KEY(flow_id,node_id,attempt_no)
    REFERENCES graph_node_attempts(flow_id,node_id,attempt_no) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,source_node_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT
);

CREATE TABLE graph_node_results (
  result_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL,
  attempt_id TEXT, attempt_no INTEGER NOT NULL CHECK(attempt_no>=0), outcome TEXT NOT NULL CHECK(outcome IN
  ('succeeded','failed','cancelled','skipped','blocked')),
  terminal_envelope_json TEXT NOT NULL, terminal_envelope_sha256 TEXT NOT NULL UNIQUE,
  result_json TEXT, result_sha256 TEXT, created_at INTEGER NOT NULL,
  UNIQUE(flow_id,node_id),
  CHECK((outcome='succeeded' AND result_json IS NOT NULL AND result_sha256 IS NOT NULL)
     OR (outcome<>'succeeded' AND result_json IS NULL AND result_sha256 IS NULL)),
  CHECK(attempt_no>0 OR (attempt_id IS NULL AND outcome IN ('skipped','blocked'))),
  FOREIGN KEY(flow_id,node_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,node_id,attempt_id,attempt_no)
    REFERENCES graph_node_attempts(flow_id,node_id,attempt_id,attempt_no) ON DELETE RESTRICT
);

CREATE TABLE graph_budget_reservations (
  flow_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  budget_kind TEXT NOT NULL CHECK(budget_kind IN ('tokens','cost_microusd')),
  reserved_amount INTEGER NOT NULL CHECK(reserved_amount>=0), created_at INTEGER NOT NULL,
  PRIMARY KEY(flow_id,node_id,attempt_no,budget_kind),
  FOREIGN KEY(flow_id,node_id,attempt_no)
    REFERENCES graph_node_attempts(flow_id,node_id,attempt_no) ON DELETE RESTRICT
);

CREATE TABLE graph_budget_settlements (
  flow_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  budget_kind TEXT NOT NULL CHECK(budget_kind IN ('tokens','cost_microusd')),
  completeness TEXT NOT NULL CHECK(completeness IN ('exact','partial','unavailable')),
  actual_amount INTEGER CHECK(actual_amount>=0), created_at INTEGER NOT NULL,
  PRIMARY KEY(flow_id,node_id,attempt_no,budget_kind),
  CHECK((completeness='exact' AND actual_amount IS NOT NULL)
     OR (completeness IN ('partial','unavailable') AND actual_amount IS NULL)),
  FOREIGN KEY(flow_id,node_id,attempt_no,budget_kind)
    REFERENCES graph_budget_reservations(flow_id,node_id,attempt_no,budget_kind) ON DELETE RESTRICT
);

CREATE TABLE agent_sessions (
  session_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, attempt_id TEXT,
  parent_session_id TEXT, provider_session_ref TEXT, kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('created','running','terminal','orphaned')),
  created_at INTEGER NOT NULL, terminal_at INTEGER, UNIQUE(flow_id,session_id),
  FOREIGN KEY(flow_id) REFERENCES graph_flows(flow_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,attempt_id) REFERENCES graph_node_attempts(flow_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,parent_session_id) REFERENCES agent_sessions(flow_id,session_id) ON DELETE RESTRICT
);

CREATE TABLE session_memory_revisions (
  session_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  checkpoint_json TEXT NOT NULL CHECK(length(checkpoint_json)<=262144),
  checkpoint_sha256 TEXT NOT NULL, previous_sha256 TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id,revision), UNIQUE(session_id,checkpoint_sha256),
  FOREIGN KEY(session_id) REFERENCES agent_sessions(session_id) ON DELETE RESTRICT
);

CREATE TABLE agent_events (
  event_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, sequence_no INTEGER NOT NULL CHECK(sequence_no>0),
  node_id TEXT, attempt_id TEXT, session_id TEXT, event_type TEXT NOT NULL,
  event_version TEXT NOT NULL, payload_sha256 TEXT, previous_event_sha256 TEXT,
  event_sha256 TEXT NOT NULL UNIQUE, trace_id TEXT, span_id TEXT, created_at INTEGER NOT NULL,
  UNIQUE(flow_id,sequence_no), UNIQUE(flow_id,event_id),
  CHECK(attempt_id IS NULL OR node_id IS NOT NULL),
  FOREIGN KEY(flow_id) REFERENCES graph_flows(flow_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,node_id) REFERENCES graph_nodes(flow_id,node_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,node_id,attempt_id)
    REFERENCES graph_node_attempts(flow_id,node_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,session_id) REFERENCES agent_sessions(flow_id,session_id) ON DELETE RESTRICT
);

CREATE TABLE agent_event_payloads (
  event_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL CHECK(length(payload_json)<=4096),
  payload_sha256 TEXT NOT NULL, FOREIGN KEY(event_id) REFERENCES agent_events(event_id) ON DELETE RESTRICT
);

CREATE TABLE agent_attempt_usage (
  usage_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  provider TEXT NOT NULL, provider_session_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('self','subtree')),
  input_tokens INTEGER, output_tokens INTEGER, cost_microusd INTEGER,
  completeness TEXT NOT NULL CHECK(completeness IN ('exact','partial','unavailable')),
  receipt_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(provider,provider_session_id,attempt_id,receipt_id), UNIQUE(flow_id,usage_id),
  FOREIGN KEY(flow_id) REFERENCES graph_flows(flow_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,attempt_id) REFERENCES graph_node_attempts(flow_id,attempt_id) ON DELETE RESTRICT
);

CREATE TABLE agent_usage_coverage (
  flow_id TEXT NOT NULL, usage_id TEXT NOT NULL, covered_attempt_id TEXT NOT NULL,
  PRIMARY KEY(usage_id,covered_attempt_id),
  FOREIGN KEY(flow_id,usage_id) REFERENCES agent_attempt_usage(flow_id,usage_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,covered_attempt_id) REFERENCES graph_node_attempts(flow_id,attempt_id) ON DELETE RESTRICT
);

CREATE TABLE agent_event_archives (
  archive_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, first_sequence INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL, archive_path TEXT NOT NULL, archive_sha256 TEXT NOT NULL UNIQUE,
  merkle_root_sha256 TEXT NOT NULL, member_count INTEGER NOT NULL CHECK(member_count>0),
  created_at INTEGER NOT NULL, CHECK(last_sequence>=first_sequence),
  UNIQUE(flow_id,archive_id),
  FOREIGN KEY(flow_id) REFERENCES graph_flows(flow_id) ON DELETE RESTRICT
);

CREATE TABLE agent_event_archive_members (
  flow_id TEXT NOT NULL, archive_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  PRIMARY KEY(archive_id,event_id),
  FOREIGN KEY(flow_id,archive_id) REFERENCES agent_event_archives(flow_id,archive_id) ON DELETE RESTRICT,
  FOREIGN KEY(flow_id,event_id) REFERENCES agent_events(flow_id,event_id) ON DELETE RESTRICT
);

CREATE TABLE flow_mcp_idempotency (
  project TEXT NOT NULL, requester TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  tool_name TEXT NOT NULL, request_sha256 TEXT NOT NULL, request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','terminal')),
  response_json TEXT, response_sha256 TEXT, created_at INTEGER NOT NULL, terminal_at INTEGER,
  PRIMARY KEY(project,requester,idempotency_key),
  CHECK((status='in_progress' AND response_json IS NULL AND response_sha256 IS NULL AND terminal_at IS NULL)
     OR (status='terminal' AND response_json IS NOT NULL AND response_sha256 IS NOT NULL AND terminal_at IS NOT NULL))
);

CREATE TABLE plan_progress_events (
  plan_id TEXT NOT NULL, sequence_no INTEGER NOT NULL CHECK(sequence_no>0),
  event_id TEXT NOT NULL UNIQUE, start_sha256 TEXT NOT NULL,
  previous_event_sha256 TEXT NOT NULL, effective_plan_sha256 TEXT NOT NULL,
  event_json TEXT NOT NULL, event_sha256 TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  PRIMARY KEY(plan_id,sequence_no)
);

CREATE TABLE plan_progress_outbox (
  event_id TEXT PRIMARY KEY, projection_payload_json TEXT NOT NULL,
  published_at INTEGER, terminal_reason TEXT,
  FOREIGN KEY(event_id) REFERENCES plan_progress_events(event_id) ON DELETE RESTRICT
);

CREATE INDEX graph_nodes_ready ON graph_nodes(flow_id,status,ready_revision);
CREATE INDEX graph_edges_source ON graph_edges(flow_id,source_id);
CREATE INDEX graph_edges_target ON graph_edges(flow_id,target_id);
CREATE INDEX graph_intents_pending ON graph_node_admission_intents(status,lease_expires_at,flow_id,node_id);
CREATE INDEX graph_attempts_latest ON graph_node_attempts(flow_id,node_id,attempt_no DESC);
CREATE INDEX agent_sessions_parent ON agent_sessions(parent_session_id,session_id);
CREATE INDEX agent_events_cursor ON agent_events(flow_id,sequence_no);
CREATE INDEX agent_usage_attempt ON agent_attempt_usage(flow_id,attempt_id);
CREATE INDEX graph_budget_flow ON graph_budget_reservations(flow_id,budget_kind);
CREATE INDEX archive_flow_range ON agent_event_archives(flow_id,first_sequence,last_sequence);
CREATE INDEX plan_progress_outbox_pending ON plan_progress_outbox(published_at,event_id);
CREATE INDEX flow_mcp_idempotency_status ON flow_mcp_idempotency(status,created_at);
