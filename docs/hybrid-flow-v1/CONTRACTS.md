# Hybrid Agent Flow v1 — normative contracts

This file is normative for `agent-collab-hybrid-flow-v1@1.0.1`. JSON is
canonicalized with RFC 8785 before hashing. Unknown fields are rejected.

## 1. Node lifecycle and readiness

Node statuses are `pending`, `ready`, `awaiting_authority`, `admitting`,
`queued`, `running`, `succeeded`, `failed`, `cancelled`, `skipped`, `blocked`,
and `needs_reconciliation`. Terminal statuses are the last six except
`needs_reconciliation`, which blocks flow closure pending operator evidence.

Only activated incoming edges participate in a join. An incoming conditional
edge becomes activated or inactive exactly once when its source terminal
envelope is accepted. Until then it is undecided.

| Incoming state | `all_success` | `all_terminal` |
|---|---|---|
| Any edge undecided | `pending` | `pending` |
| No activated edges after all decisions | `skipped` | `skipped` |
| Activated parent non-terminal | `pending` | `pending` |
| All activated parents succeeded | `ready` | `ready` |
| All activated parents terminal; at least one failed/cancelled/skipped/blocked | `blocked` | `ready` with terminal envelopes and no missing success output |
| Any activated parent `needs_reconciliation` | `blocked` until reconciled | `blocked` until reconciled |

A node skipped or blocked by this table emits a terminal envelope and propagates
edge decisions. Terminal precedence is deterministic: (1)
`needs_reconciliation` while any node is ambiguous; (2) `cancelled` after an
accepted cancellation when every node is terminal and none is ambiguous; (3)
`failed` when every node is terminal and any reachable node failed or blocked;
(4) `succeeded` only when every node is terminal and every reachable non-skipped
node succeeded. CAS applies these predicates in that order.

## 2. Durable transaction boundaries

`GraphResultUoW` uses `BEGIN IMMEDIATE` and atomically:

1. CAS-accepts one node-final terminal envelope per `(flow_id,node_id)` after a
   success or exhaustion of the locked bounded retry policy;
2. appends edge evaluations and lifecycle events;
3. reduces affected nodes;
4. inserts one admission intent per newly ready node using
   `UNIQUE(flow_id,node_id,ready_revision)`.

`NodeAdmissionUoW`, after external capture, atomically:

1. CAS-claims the exact pending intent;
2. validates definition, readiness, input, checkpoint, source, MAP, routing,
   adapter-policy, and admission hashes;
3. reserves worst-case budget;
4. consumes an approval whose consumer is
   `(flow_id,node_id,ready_revision,admission_sha256)` when required;
5. creates one attempt, existing bounded workflow, and dispatch-outbox row.

The runtime-derived resource key is the canonical realpath plus project
identity. `resourceHint`, if supplied, must equal it. No external I/O occurs in
either transaction.

Intermediate failures append `AttemptTerminalReceipt/v1` events and drive only
the existing retry policy. They never evaluate graph edges. The node-final
envelope records the satisfying attempt or attempt zero for scheduler-generated
skip/block.

## 3. Persistence minima

All graph tables use `flow_id TEXT NOT NULL` and foreign keys with
`ON DELETE RESTRICT`. Immutable definition/result/admission/event rows cannot be
updated or deleted by application APIs. Lifecycle projection rows carry
`version INTEGER NOT NULL` for compare-and-swap.

The exact additive DDL is `STATE_V4_SCHEMA.sql`. Required uniqueness includes:

- `graph_flows(flow_id)` and `graph_flows(definition_sha256)` per project;
- `graph_nodes(flow_id,node_id)`;
- `graph_edges(flow_id,edge_id)` and `(flow_id,source_id,target_id,condition_sha256)`;
- `graph_edge_evaluations(flow_id,edge_id,source_attempt_no)`;
- `graph_node_admission_intents(flow_id,node_id,ready_revision)`;
- `graph_node_attempts(flow_id,node_id,attempt_no)` and non-null `workflow_id`;
- `graph_node_results(flow_id,node_id)`;
- `agent_events(flow_id,sequence_no)`, `event_id`, and `event_sha256`;
- `agent_attempt_usage(provider,provider_session_id,attempt_id,receipt_id)`;
- `graph_budget_reservations(flow_id,node_id,attempt_no,budget_kind)`;
- `graph_budget_settlements(flow_id,node_id,attempt_no,budget_kind)`;
- `agent_usage_coverage(usage_id,covered_attempt_id)`;
- `agent_event_archives(archive_id)` and
  `agent_event_archive_members(archive_id,event_id)`;
- `flow_mcp_idempotency(project,requester,idempotency_key)`.

Every admission intent has `pending | claimed | admitted | stale | cancelled |
budget_blocked`; claiming uses CAS and a bounded lease. Reservation and
settlement are separate append-only rows. `BudgetReservation/v1` is broker
derived after routing-v5 from verified input size, requested and enforced token
limits, retry/failover bound, generated-coordination allowance, price-catalog
hash, and provider/model price inputs. Caller cost is ignored. Zero is valid
only for a deterministic transform with no provider session. Unknown pricing or
an unenforceable provider limit blocks budget-dependent admission. For each budget kind, atomic admission
requires `SUM(CASE WHEN settlement.completeness='exact' THEN
settlement.actual_amount ELSE reservation.reserved_amount END) + requested <=
flow_ceiling`. Partial or unavailable settlement remains charged at the full
reservation. Runtime node limits enforce `actual <= reserved`;
violation is `needs_reconciliation` and blocks new admission.

Event sequence and `previous_event_sha256` are allocated in the transition
transaction. Payload bodies are at most 4 KiB in `agent_event_payloads`; an
archive operation writes and fsyncs an immutable segment, records its manifest
and exact event membership, verifies every payload/member/root hash, appends an
archive-anchor event, then may delete only archived payload bodies. Event rows,
digests, sequence, manifest, membership, and anchors remain.

The restore guard is `<state-dir>/migration-guard/state-v4-<backup-sha256>.jsonl`,
outside the database and `VACUUM INTO` target. Its canonical hash-chained records
are `backup_created`, `service_reopened`, `mutable_write_admitted`, and
`restore_consumed`, each with sequence, previous hash, database identity,
backup hash, table-digest-manifest hash, timestamp, and record hash. Creation and
each append use temp-file/rename plus directory fsync before the corresponding
reopen/write. Physical restore requires a valid chain containing only
`backup_created`; a missing, truncated, extra, or consumed chain rejects restore.

## 4. MCP contracts

The strict schema registry is `MCP_FLOW_V1_SCHEMAS.json`. It is not compiled as
one schema: for each tool, the verifier constructs a schema from the registry's
`$schema`, `$defs`, and exactly one `tools.<name>.request|response`, then compiles
that extracted schema with Ajv `strict: true`. Every request contains `schemaVersion`, `project`, `requester`, and
`idempotencyKey`; persisted mutations also contain `expectedDefinitionSha256`.
Every response contains `schemaVersion`, `requestId`, and one strict tagged
result. Reusing an idempotency key with different canonical bytes is a conflict.
Mutation request bytes and their terminal tagged response are persisted in
`flow_mcp_idempotency`; replay after restart returns the identical response.
Project resolution and requester/origin checks happen before lookup to prevent
cross-project disclosure.

| Tool | Required mutation fields | Success result |
|---|---|---|
| `collab_flow_validate` | none; canonical definition | validation report and definition hash |
| `collab_flow_submit` | definition | immutable `flowId`, hash, status |
| `collab_flow_start` | `flowId`, root admission hash, optional exact approval reference | admitted, awaiting-authority, stale, or budget-blocked |
| `collab_flow_admit_node` | `flowId`, `nodeId`, `readyRevision`, exact admission hash, approval reference | admitted, awaiting-authority, stale, or budget-blocked |
| `collab_flow_cancel` | `flowId`, expected flow version, reason, origin-requester or exact operator approval | cancelled, cancellation-requested, needs-reconciliation, or already-terminal |

Read tools use bounded limits: status depth <= 8, events page <= 100, result
payload <= 256 KiB. Cursors bind project, flow, last sequence, filter hash, and
expiry and are authenticated by the local broker.

Only the original `(origin,requester)` may use `origin_requester` cancellation.
A different local operator must use a one-time `flow-cancel` ApprovalLedger
grant bound to `(project,flow_id,expected_flow_version,operator_id,cancel_hash)`;
the cancellation UoW consumes it. Cancellation marks all non-started intents cancelled and prevents
new admission. Read-only attempts may be interrupted. Mutable/external attempts
are interrupted best-effort; uncertain launch/effects become
`needs_reconciliation`, never success and never automatically retried.

## 5. Execution adapter policy

`ExecutionAdapterPolicy/v1` is immutable, broker-owned, and selected only after
existing routing-v5 has produced the Codex-owned read-only assignment. Prime is
a subprocess backend, not an `ActiveAgentId`, `ReviewProviderId`, origin,
assignment owner, routing target, or failover candidate. Version 1 permits Prime
only in shadow/evaluation and cannot change the authoritative result.

## 6. Result and usage accounting

`NodeTerminalEnvelope/v1` is node-final and always carries identity, satisfying
attempt (or zero for scheduler skip/block), outcome, timestamps,
snapshot hash, and error classification. It carries `NodeResult/v1` only for a
schema-valid success. Retries are distinct attempts and all consume usage; only
one accepted terminal attempt can satisfy a node.

Generated bounded-workflow coordination stages are child sessions of the graph
node attempt and count toward wall time, tokens, and cost. Deduplicate receipts
by their required identity. Sum uncovered `self` receipts. Every subtree receipt
persists its exact covered attempt IDs in `agent_usage_coverage`; without that
set it is unavailable. For attempts lacking self receipts, consider subtree
receipts by descending covered-set size then lexicographic usage ID. Select one
only when its uncovered set does not overlap a selected receipt; skipped overlap
or uncovered attempts make completeness `partial`. Unknown is never zero.
