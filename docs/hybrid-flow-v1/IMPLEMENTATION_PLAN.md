# Hybrid Agent Flow v1 — stabilized implementation plan

## Plan identity

| Field | Value |
|---|---|
| Plan ID | `agent-collab-hybrid-flow-v1` |
| Revision | `1.0.1` |
| Status | `STABILIZED_READY_FOR_LOCK` |
| Normative artifact | this file |
| Baseline repository | `/home/anton/Source/agent-collab` |
| Baseline branch | `master` |
| Source baseline HEAD | `d0f6cda738cf08ff851f14192ff48e636c1f0f17` |
| Routing policy | `routing-v5` |
| C4 index | `repo-c4.json`, generated and validated 2026-08-31 |
| Progress projection | `docs/hybrid-flow-v1/IMPLEMENTATION_PROGRESS.md` |
| Risk register | `docs/hybrid-flow-v1/RISK_REGISTER.md` |
| Normative contracts | `docs/hybrid-flow-v1/CONTRACTS.md` |
| Evidence protocol | `docs/hybrid-flow-v1/EVIDENCE_PROTOCOL.md` |
| State schema | `docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql` |
| MCP schemas | `docs/hybrid-flow-v1/MCP_FLOW_V1_SCHEMAS.json` |

This plan is stable but implementation has not started. At implementation start,
the lock procedure in section 13 creates `IMPLEMENTATION_START.json` over the
exact normative-package manifest. From that point, the plan, contracts, evidence
protocol, and lock manifest must not change. Progress starts in immutable
start-rooted receipts, moves atomically to SQLite at schema v4, and is exported
to JSONL and `IMPLEMENTATION_PROGRESS.md`. A
normative change requires a hash-chained amendment or a new plan revision.

## 1. Objective

Add safe graph-based multi-agent orchestration and a read-only Prime Agent
execution lane above the existing `agent-collab` safety kernel.

The delivered system must support:

- fan-out of independent read-only nodes;
- fan-in through deterministic joins;
- conditional routing from schema-validated results;
- typed, hash-bound node outputs and downstream inputs;
- node-time workspace snapshots and authority consumption;
- flow/session-scoped working memory;
- complete root/descendant lifecycle and resource telemetry;
- a read-only Prime Agent RPC adapter in shadow and bounded canary modes.

## 2. Non-goals

- Replacing `ApprovalLedger`, `ExecutionAdmission`, dispatch outbox, `RunStore`,
  worktree leases, reconciliation, six-lane review, or MAP learning.
- Allowing a model or Prime Agent to select provider, model, effort, failover,
  approval scope, or writer identity.
- Giving Grok, Claude, Prime Agent children, or any alternative provider write
  authority.
- Mutable Prime Agent execution. It requires a separate plan and certification.
- Arbitrary JavaScript, JSONPath, CEL, model-evaluated predicates, or user code
  in edge conditions.
- Cyclic graphs, in-place graph mutation, distributed deployment, a network
  control-plane listener, vector memory, or global automatic refinement.
- Treating model text, a manually checked box, or a partial review set as PASS.

## 3. Current architecture and preserved boundaries

The C4 index describes one local CLI/MCP container. Relevant existing component
IDs are `app`, `mcp`, `workflow`, `runtime`, `store`, `worker`, `runners`,
`flow`, `security`, `history`, `migration`, and `worktree`.

The following boundaries remain authoritative:

- `workflow` owns bounded execution state and deterministic transitions.
- `runtime` owns admission, recovery, and provider-result application.
- `store` owns SQLite persistence, CAS, outbox, queue leases, and fencing.
- `security` owns approval and redaction decisions.
- `worktree` owns the Codex-only mutation lease.
- `flow` owns exact execution/MAP/learning evidence.
- `mcp` and provider runners are adapters; they do not make domain decisions.

The new graph layer composes bounded workflows. It does not make the queue a DAG
scheduler and does not duplicate safety decisions.

## 4. Weakness analysis and selected remedies

| ID | Confirmed weakness | Root cause | Selected remedy | Deliberately rejected approach |
|---|---|---|---|---|
| `W-01` | Workflow is linear | `CollaborationRun` has one `activeStage`; readiness follows array order | Add immutable `GraphFlow/v1` and a pure graph readiness reducer above bounded workflows | Rewrite the existing reducer in one step |
| `W-02` | Public delegation accepts one bounded stage | `collab_delegate` and `LocalCollabService.delegate()` construct one target stage | Add strict `flow/v1` MCP tools; keep the existing tool byte-compatible | Add optional graph fields to the existing strict schema |
| `W-03` | No fan-out, fan-in, join, or conditions | Queue has one predecessor and runtime selects the next array item | Scheduler publishes every ready node as an independent bounded workflow; joins remain graph-owned | Store predecessor arrays in `runs` or use the queue as a graph engine |
| `W-04` | A stage result is not a typed input | Completion accepts a result hash transiently but does not durably preserve typed result identity; provider output is text | Add `NodeResult/v1`, JSON Schema validation, immutable input bindings, and explicit transform nodes | Infer downstream inputs from transcript text |
| `W-05` | Snapshots are built upfront | Admission snapshots all stages when a workflow starts | Admit each graph node only when ready; bind current source, upstream results, memory revision, MAP, and authority | Reuse an earlier snapshot after source or input drift |
| `W-06` | No session-scoped working memory | History is an external read-only index, not execution state | Add bounded, append-only `SessionCheckpoint/v1` revisions owned by the broker | Use native provider memory as trusted state or add a vector DB in v1 |
| `W-07` | Tree telemetry is incomplete | Normal runs discard usage and there is no causal flow/session ledger | Add append-only events, sessions, usage receipts, subtree aggregation, bounded MCP projections, and optional OpenTelemetry export | Use logs as the source of truth or report unknown usage as zero |
| `W-08` | Queue supports one predecessor | `depends_on_run_id` is execution-order state | Give the queue only already-ready nodes; graph dependencies never enter `runs` | Alter `depends_on_run_id` into JSON or add graph decisions to `RunStore` |

## 5. Target flow

```text
GraphFlow/v1 submission
        |
        v
schema + DAG + budget validation
        |
        v
Graph scheduler ------> SessionCheckpoint manifest
        |                         |
        | ready node              |
        v                         v
NodeAdmission (JIT source + inputs + MAP + authority)
        |
        v
existing bounded CollaborationRun -> outbox -> RunStore -> worker -> runner
        |                                                     |
        |                           typed result + usage <-----+
        v
GraphResultUoW
  result validation -> edge decisions -> node/event persistence
  -> ready state + idempotent NodeAdmissionIntent
        |
        v
external evidence capture (source + MAP + inputs + memory)
        |
        v
NodeAdmissionUoW
  CAS intent -> reserve budget -> consume exact approval
  -> attempt + bounded workflow + existing dispatch outbox
        |
        v
deterministic verifier -> existing six-lane review -> MAP learning proposal
```

No filesystem, provider, model, or tool call is allowed inside either SQLite
transaction. `GraphResultUoW` never launches work. `NodeAdmissionUoW` operates
only on externally captured immutable bytes and revalidates their hashes.

## 6. Normative contracts

### 6.1 `GraphFlow/v1`

The canonical JSON contract contains:

- `schemaVersion`, `flowId`, `taskId`, `project`, `origin`;
- `definitionSha256`, computed over canonical bytes without the digest field;
- `budget`: maximum nodes, active read-only nodes, child-flow depth, tokens,
  wall time, optional cost ceiling, and per-node requested token limits from
  which the broker derives enforceable worst-case reservations;
- `nodes`: unique bounded definitions;
- `edges`: unique directed dependencies;
- one `coordination` root reachable to every node;
- no provider, model, effort, session ID, or failover target.

Each node contains:

- `nodeId`, canonical stage kind and role;
- `approvalScope` and optional `resourceHint`;
- prompt template reference and immutable artifact reference;
- typed input ports and one output JSON Schema;
- `joinPolicy`: `all_success` or `all_terminal`;
- allowed `route` enum values;
- timeout and retry bounds no wider than existing runtime policy.

Version 1 limits: at most 100 nodes, 400 edges, depth 8, and three concurrently
active read-only nodes by default. The runtime derives the canonical mutable
resource key from the resolved project/worktree; a caller hint is only an
assertion and mismatch rejects admission. Mutable nodes are serialized by the
existing worktree lease.

### 6.2 Conditional edges

An edge may activate from:

- the canonical provider outcome class; or
- the top-level `route` value of a validated `NodeResult/v1`.

Allowed routes are declared by the producer node's output schema. Edge decisions
are persisted once with the exact source terminal-envelope hash and evaluator
version. They are never recalculated during replay. Joins quantify only over
activated incoming edges. The readiness, skip, blocked, and flow-terminal truth
table in `CONTRACTS.md` is normative. A data transformation requires an explicit
transform node.

### 6.3 `NodeResult/v1`

Required fields:

- flow, node, bounded workflow, run, attempt, and session identities;
- result-schema hash and validator version;
- canonical output payload and output hash;
- `route` or `null`;
- execution-snapshot hash and source fingerprint;
- usage receipt with provenance and completeness `exact | partial | unavailable`;
- terminal outcome and timestamps.

Invalid or unparseable output terminates the node as a task failure. It cannot
open downstream nodes and must not be converted to a prose success.

Every attempt produces `AttemptTerminalReceipt/v1` telemetry. Only a success or
the final failure/cancellation after the bounded retry policy is exhausted
produces the single node-final `NodeTerminalEnvelope/v1` that may evaluate
edges. Outcome and error classification are always present. A typed output is
present only for a schema-valid success; `all_terminal` consumers receive
envelopes and cannot pretend a failed parent supplied its success output port.

### 6.4 `NodeAdmission/v1`

Node admission binds:

- graph and node definition hashes;
- activated edge decisions;
- exact upstream result/input-binding hashes;
- exact session-checkpoint revision and manifest hash;
- current workspace fingerprint;
- current MAP profile and promoted-learning identity;
- execution snapshot;
- approval consumer key for this node;
- routing decision created by the existing runtime.

Admission follows two durable boundaries. `GraphResultUoW` appends an idempotent
`NodeAdmissionIntent` after readiness is decided. An admission worker captures
workspace/MAP/input/memory bytes outside SQLite. `NodeAdmissionUoW` then checks
the intent CAS and exact hashes, reserves the worst-case node budget, consumes
approval, and creates the attempt, bounded workflow, and existing dispatch
outbox atomically. Pre-launch reconstruction checks the same hashes. Drift after
authority consumption blocks launch, marks the attempt `stale_after_admission`,
releases only independently verifiable unused budget, and requires a new intent
and new authority; authority is never reused.

Each non-root graph node maps to one existing bounded workflow. Its generated
internal coordination stage remains part of that workflow and is counted in
budget and telemetry, but it is not a second graph node. The requested target
stage alone owns `NodeTerminalEnvelope/v1`. A graph root whose stage is already
`coordination` does not receive another coordination stage.

### 6.5 `SessionCheckpoint/v1`

A checkpoint is a maximum 256 KiB canonical structured document containing:

- objective and active plan reference;
- loaded instruction references;
- artifact and predecessor-result references;
- open issues and next action;
- compaction reason and hashes of replaced revisions.

It is scoped to one project, flow, and session; revisions form a hash chain.
Secrets are rejected/redacted. Approval state is never trusted from memory:
rehydration reads authority from `ApprovalLedger`.

### 6.6 `FlowEvent/v1` and usage

Events are append-only and contain event/flow/node/attempt/session/parent-session,
trace/span identities, event type/version, timestamps, bounded redacted payload,
payload hash, previous-event hash, and correlations to snapshot/result/dispatch.

Usage uses nullable integer fields and provenance per field. Cost is stored in
micro-USD as an integer. `self` and `subtree` accounting scopes cannot be summed
together. Missing provider data remains `NULL` with `unavailable` provenance.
Hidden reasoning, credentials, raw tool arguments, and raw tool results are not
telemetry payloads.

Sequence numbers are monotonic per flow and hash-chain append occurs in the
same transaction as the represented transition. Immutable event headers and
hashes are retained indefinitely. Bounded payload bodies live separately and
may be moved, for terminal flows only, into a hash-verified immutable archive;
an archive-anchor event and payload digest remain in SQLite. Active or
reconciliation flows are never archived. Retry and generated-coordination usage
is counted once by receipt identity `(provider, providerSession, attempt,
receiptId)`. `self` receipts roll up; `subtree` receipts replace, never add to,
covered descendant receipts. Mixed or incomplete coverage remains `partial`.

Before concurrent admission, the broker derives the worst-case reservation from
the node's requested token limit, input bound, routing-v5 decision, enforced
provider limit, retry/failover bound, generated coordination overhead, and a
locked pricing snapshot. Caller-provided cost is never trusted. Admission fails
closed when a bound cannot be enforced. `NodeAdmissionUoW` atomically reserves
the derived amounts. Actual receipts reconcile the reservation on terminal
transition. Missing token or cost telemetry never
releases the corresponding reservation and blocks further budget-dependent
admission fail-closed. Wall time uses a flow deadline and does not rely on
provider usage reporting.

## 7. MCP compatibility contract

Existing tools retain their current strict schemas and semantics. Add:

- `collab_flow_validate` — deterministic validation without persistence;
- `collab_flow_submit` — persist an immutable flow definition;
- `collab_flow_start` — admit the root when authority permits;
- `collab_flow_admit_node` — supply authority for one exact ready-node
  admission hash; otherwise the node remains `awaiting_authority`;
- `collab_flow_status` — bounded tree/status/usage projection;
- `collab_flow_events` — cursor-paginated redacted events;
- `collab_flow_result` — typed terminal result lookup;
- `collab_flow_cancel` — bounded cancellation with reconciliation for ambiguous
  mutable attempts.

Every response includes its own `schemaVersion`. `collab_status` advertises
`capabilities.graphFlow = "flow/v1"`; the MCP protocol remains
`agent-collab/v2` during the additive compatibility period.

Strict request/response schemas, requester/project isolation, idempotency,
authority binding, cancellation rules, and terminal-error forms are normative
in `CONTRACTS.md`. Cancellation is allowed only to the initiating origin and
requester or an explicitly authorized local operator. It stops future
admissions. Active mutable/external attempts are terminated best-effort and
become `needs_reconciliation` when launch or effects are ambiguous; cancellation
never converts them to success and never broadens authority.

## 8. Library-first decisions

- Use `@dagrejs/graphlib@4.0.5` for graph construction, cycle detection, and
  topological validation. Domain readiness, authority, persistence, and
  outbox decisions remain in project code.
- Use `ajv@8.20.0` in JSON Schema 2020 mode for node output/input validation.
- Use `@opentelemetry/api@1.9.1` only as an optional trace projection. Durable
  SQLite events remain the source of truth and exporter failure is non-blocking.
- Do not use XState for the DAG. It would not replace graph persistence,
  transactional outbox, node admission, or authority logic and would increase
  the maintained adapter surface.
- Do not add a vector database or a second workflow service in version 1.

Dependency versions are exact implementation inputs. A version change after
plan lock requires an amendment with compatibility evidence.

## 9. Persistence and migration

State schema v4 is additive. History remains schema v2.

New tables:

- `graph_flows` — immutable definition plus compact lifecycle state/CAS version;
- `graph_nodes` — immutable node definition and current node status;
- `graph_edges` — immutable edges and join semantics;
- `graph_edge_evaluations` — append-only condition decisions;
- `graph_node_attempts` — links graph nodes to bounded workflows/runs/sessions;
- `graph_node_admissions` — immutable node admission bytes and hashes;
- `graph_node_admission_intents` — idempotent ready-to-capture work with CAS;
- `graph_budget_reservations` — atomic worst-case reservations;
- `graph_budget_settlements` — append-only actual/unavailable settlement;
- `graph_node_input_bindings` — immutable typed upstream bindings;
- `graph_node_results` — one accepted typed result per node;
- `agent_sessions` — parent/child lifecycle and provider-session reference;
- `session_memory_revisions` — bounded hash-chained checkpoints;
- `agent_events` — causal operational ledger;
- `agent_event_payloads` — bounded bodies separable for verified archival;
- `agent_attempt_usage` — deduplicated provider usage receipts;
- `agent_usage_coverage` — exact attempt identities covered by subtree receipts;
- `agent_event_archives`, `agent_event_archive_members` — verified archive
  manifests and immutable membership.
- `flow_mcp_idempotency` — durable canonical request/terminal response replay;
- `plan_progress_events` — start-rooted evidence/amendment chain and authority
  consumption in the same SQLite transaction;
- `plan_progress_outbox` — idempotent JSONL/Markdown projection publication.

Exact columns, types, keys, foreign keys, status checks, CAS versions,
uniqueness, and indexes are fixed by `STATE_V4_SCHEMA.sql`; semantic invariants
are fixed in `CONTRACTS.md`. Implementation may add indexes but cannot weaken
constraints without an amendment.

Migration sequence:

1. Release, restart, and independently verify a compatibility runtime that
   accepts state/history pairs `3/2` and `4/2` with graph execution disabled.
2. Stop the user service and block new admission.
3. Create a hash-verified `VACUUM INTO` backup and record an exact database
   write epoch plus digests/watermarks for every mutable legacy table and create
   a hash-chained, fsync'd restore-guard journal outside the database/backup.
4. Apply additive v3-to-v4 DDL in one exclusive transaction.
5. Run `integrity_check`, `foreign_key_check`, exact schema/index validation,
   then start with graph execution disabled.
6. Enable shadow scheduling, followed by real read-only execution only after
   the relevant stage gates pass.

Existing workflow rows are not synthesized into graphs. They finish under the
legacy bounded runtime or remain historical. The ten reconciliation rows seen
during planning require operator evidence; the migration must not reinterpret
them as success.

Physical restoration is allowed only before any post-backup mutable write or
service reopen, as proved by the unchanged write epoch/table digests and the
external restore-guard journal. The journal is appended and fsync'd before a
service reopens or admits a write; absence, truncation, or hash mismatch blocks
restore fail-closed.
After the first service restart or mutable write, rollback is feature-off plus a
forward fix (or an additive, data-preserving down migration) on schema v4. The
absence of graph rows alone is never sufficient to restore the backup.

## 10. Implementation stages

The order is normative. A later stage may not begin before the predecessor has
its complete stage-close evidence.

### `STG-00` — freeze and execution admission

Deliverables:

- verify plan and lock hashes;
- capture exact branch, HEAD, worktree, MAP profile, routing, and service state;
- create `IMPLEMENTATION_START.json` after explicit implementation authority;
- as the first product-source change, implement the pre-v4 immutable-receipt
  verifier defined by `EVIDENCE_PROTOCOL.md`, including negative controls;
- record commit/push/live-provider authority separately;
- confirm no overlapping edits and classify every active/reconciliation row.

Gate: no product source mutation occurs before the start receipt is valid. The
verifier is the first implementation slice; until it passes, progress remains
`UNVERIFIED_PROJECTION` and `STG-00` cannot close.

### `STG-01` — immutable graph and result contracts

Owned files:

- NEW `src/workflow/flow-contract.ts`;
- NEW `src/workflow/flow-graph.ts`;
- NEW `tests/flow-contract.test.ts`;
- `package.json`, `package-lock.json` for exact Graphlib and Ajv dependencies.

Deliverables:

- canonical `GraphFlow/v1`, `NodeResult/v1`, condition, join, budget schemas;
- DAG validation through Graphlib;
- JSON Schema compile/validation through Ajv;
- negative controls for cycles, unreachable nodes, dangling edges, duplicate
  IDs, invalid route enums, oversized definitions, and provider/model fields.

Gate: pure contracts only; no runtime behavior changes.

### `STG-02` — deployed compatibility runtime

Owned files:

- `src/migration/coordinator.ts`, `src/cli.ts`, `src/store/state-layout.ts`;
- NEW `tests/schema-compatibility.test.ts`.

Deliverables:

- v3/v4 compatibility opening rules with graph execution hard-disabled;
- deterministic compatibility and legacy-write tests;
- an authorized deploy/restart/reopen receipt before any v4 DDL.

Gate: the deployed runtime reopens v3 and synthetic v4 stores while every
legacy contract remains byte-compatible.

### `STG-03` — additive schema v4

Owned files:

- `src/migration/coordinator.ts`, `src/migration/operational-restore.ts`;
- `src/store/state-layout.ts`;
- NEW `src/store/graph-flow-store.ts`;
- NEW `tests/migration-v4.test.ts`, `tests/graph-flow-store.test.ts`.

Deliverables:

- write-epoch/digest guarded backup, migration, integrity, rollback, and
  fault-injection evidence;
- graph stores with canonical-byte/hash and idempotency conflict checks;
- atomically import the start-rooted pre-v4 receipt chain into
  `plan_progress_events`; SQLite becomes canonical at that point;
- graph feature remains disabled.

Gate: populated v3 data survives byte-for-byte where its schema is unchanged.

### `STG-04` — event/session telemetry on the current linear path

Owned files:

- NEW `src/runtime/flow-telemetry.ts`;
- `src/runners/agent-runner.ts`, `src/runners/codex.ts`,
  `src/runners/grok.ts`, `src/runners/claude.ts`;
- `src/worker/durable-worker.ts`, `src/app/service.ts`;
- NEW `tests/flow-telemetry.test.ts`.

Deliverables:

- append-only events, sessions, and usage for existing runs;
- exact/partial/unavailable provenance;
- subtree aggregation without double counting;
- retention/export policy and bounded payload enforcement.

Gate: exporter failure cannot change workflow state; no sensitive payload enters
the event ledger.

### `STG-05` — typed node results and session checkpoints

Owned files:

- NEW `src/runtime/node-result.ts`;
- NEW `src/runtime/session-context.ts`;
- `src/store/graph-flow-store.ts`, `src/runners/agent-runner.ts`;
- NEW `tests/node-result.test.ts`, `tests/session-context.test.ts`.

Deliverables:

- structured output parsing and local schema validation;
- immutable input bindings and result persistence;
- session checkpoint CAS/hash-chain, compaction, isolation, and rehydration;
- bounded untrusted context assembly.

Gate: invalid output and tampered memory never open downstream execution.

### `STG-06` — pure reducer and shadow scheduler

Owned files:

- NEW `src/workflow/flow-reducer.ts`;
- NEW `src/runtime/graph-scheduler.ts`;
- `src/store/graph-flow-store.ts`, `src/runtime/collaboration-runtime.ts`;
- NEW `tests/graph-scheduler.test.ts`.

Deliverables:

- pure deterministic readiness/skip/terminal reducer;
- persisted edge decisions, ready states, and admission intents;
- multi-process CAS and crash/replay tests;
- shadow comparison against legacy sequencing with no graph dispatch.

Gate: no readiness mismatch, provisional sequencing path, duplicate intent, or
dispatch in the deterministic shadow corpus.

### `STG-07` — node-time admission dry run

Owned files:

- NEW `src/runtime/node-admission.ts`;
- `src/runtime/execution-admission.ts`;
- `src/runtime/collaboration-runtime.ts`;
- `src/flow/execution-snapshot.ts`, `src/security/approval-ledger.ts`;
- NEW `tests/node-admission.test.ts`.

Deliverables:

- JIT capture and exact ready-node admission-hash calculation;
- derived mutable resource identity and caller-hint mismatch rejection;
- budget reservation and per-node approval paths tested against an isolated
  ledger, without creating a real bounded workflow or dispatch;
- exact graph/input/memory binding checked again before provider launch;
- stale-after-authority, authority non-reuse, and reconciliation semantics.

Gate: no graph provider dispatch is possible; every dry-run intent reaches one
deterministic admitted, awaiting-authority, stale, budget-blocked, or cancelled
state.

### `STG-08` — sequential graph execution bridge

Owned files:

- `src/runtime/node-admission.ts`, `src/runtime/graph-scheduler.ts`;
- `src/runtime/collaboration-runtime.ts`;
- `tests/node-admission.test.ts`, `tests/graph-scheduler.test.ts`.

Deliverables:

- `NodeAdmissionUoW` creates exactly one existing bounded workflow/outbox;
- one-active-node mode consumes only the certified reducer;
- generated coordination-stage accounting and target-stage result ownership;
- legacy-equivalence and crash/replay evidence.

Gate: sequential graph execution produces the same verified outcome as its
legacy equivalent with no duplicate attempt, authority, budget, or dispatch.

### `STG-09` — read-only fan-out, fan-in, and conditional routing

Owned files:

- `src/runtime/graph-scheduler.ts`, `src/runtime/node-admission.ts`;
- `src/runtime/collaboration-runtime.ts`, `src/store/collaboration-run-store.ts`;
- `tests/graph-scheduler.test.ts`, `tests/collaboration-runtime.test.ts`.

Deliverables:

- atomically publish every ready read-only node;
- `all_success`, `all_terminal`, outcome, and route semantics;
- independent branch failure, unreachable join, cancellation, and recovery;
- concurrency and SQLite contention measurements.

Gate: mutable fan-out remains disabled; a join cannot run from partial or
unvalidated evidence.

### `STG-10` — additive MCP flow API

Owned files:

- `src/mcp/server.ts`, `src/app/service.ts`, `src/cli.ts`;
- `src/security/approval-ledger.ts` for the exact one-time `flow-cancel` scope;
- NEW `tests/mcp-flow.test.ts`;
- `README.md`, `README.ru.md`, operating workflow documentation.

Deliverables:

- all `flow/v1` tools from section 7, including exact downstream-node authority
  admission and cancellation, with strict limits and pagination;
- origin/requester cancellation and operator `flow-cancel` consumer binding;
- capability discovery;
- legacy MCP contract tests remain unchanged;
- a compatibility projection from a one-stage request to graph validation is
  measured but does not silently change existing semantics.

Gate: existing clients pass byte-compatible contract tests.

### `STG-11` — Prime Agent read-only shadow adapter

Owned files:

- NEW `src/runners/prime-agent.ts`;
- NEW `src/runners/prime-rpc.ts`;
- `src/runners/provider-command.ts`;
- NEW `tests/prime-agent-runner.test.ts`.

Deliverables:

- pinned executable/source identity and strict LF-delimited JSONL parser;
- read-only sealed workspace and bounded depth/concurrency/budget;
- broker-owned immutable `ExecutionAdapterPolicy/v1`; Prime is never added to
  `ActiveAgentId`, `ReviewProviderId`, routing-v5, origin, assignment, or
  failover identities;
- fixed control-plane-selected provider/model; model switching, schedules, global
  memory, refinement, and write tools denied;
- stable session/child handles, recovery, event and usage normalization;
- shadow mode only until deterministic certification passes.

Gate: Prime is only a subprocess backend beneath a Codex-owned read-only node.
It cannot broaden authority, select routing, mutate the source worktree, or
bypass the graph/event ledger. A routed Prime lane requires a future routing-v6
amendment and separate certification.

### `STG-12` — paired evaluation, cutover decision, and cleanup

Owned files:

- eval corpus/manifests and hidden oracles;
- graph/Prime reports under an isolated run root;
- affected docs and `repo-c4.json`.

Deliverables:

- deterministic harness certification;
- current linear versus graph and graph versus Prime-shadow paired evidence;
- crash/restart/compaction and policy-violation matrices;
- live provider canary only under separate exact approval;
- decision: reject, continue shadow, or enable read-only graph by default;
- remove expired transitional fallback/duplicate decisions after successful
  cutover, or remove candidate integration after rejection.

Gate: no production or mutable Prime claim is made from deterministic or
shadow-only evidence.

## 11. Acceptance scenarios

1. Given two independent read-only nodes, when their predecessor completes,
   then two distinct bounded workflows are admitted without shared mutable
   authority.
2. Given a join with `all_success`, when only one parent is terminal, then the
   join remains closed.
3. Given an allowed result route, when the typed result validates, then only the
   matching edge activates and the decision is replay-stable.
4. Given a schema mismatch or tampered result hash, when completion arrives,
   then downstream nodes remain closed and the node is terminally failed.
5. Given workspace, MAP, input, or memory drift between readiness and launch,
   when pre-launch validation runs, then launch is blocked without reusing
   authority.
6. Given a crash at admission, outbox publication, queue claim, or result
   application, when recovery runs, then no mutable effect or node attempt is
   duplicated.
7. Given two flows in one project, when one session is rehydrated, then it cannot
   read the other flow's checkpoint.
8. Given exact and unavailable usage in one tree, when totals are projected,
   then known totals are correct and completeness remains partial.
9. Given a legacy `collab_delegate` client, when graph capability is installed,
   then its request and response contract remain unchanged.
10. Given a Prime Agent child that attempts a write, model switch, schedule, or
    global refinement, when the adapter validates the operation, then it is
    denied and recorded without fallback.
11. Given a degraded review provider set, when stage close is evaluated, then
    it remains `DEGRADED_REVIEW_SET`, never PASS.
12. Given a manual checkbox edit without evidence, when progress is verified,
    then the step remains incomplete.
13. Given a later mutable node becomes ready, when no exact authority is
    supplied, then it remains `awaiting_authority`; authority for another node,
    plan, source, or admission hash is rejected.
14. Given concurrent ready nodes whose reservations exceed the remaining flow
    budget, when admission races, then atomic reservations admit only a safe
    subset and the others remain `budget_blocked`.
15. Given cancellation by another requester or origin, when the request is
    validated, then it is rejected; an ambiguous active mutable attempt enters
    reconciliation rather than cancelled-success.
16. Given no conditional outgoing edge activates, when the producer becomes
    terminal, then unreachable descendants are deterministically skipped or
    blocked according to the normative truth table and the flow terminates.

## 12. Verification and stage-close contract

Every implementation stage must pass its focused tests plus:

```bash
npm run test:flow
npm run typecheck
npm run build
npm run map:verify
python3 /home/anton/.agents/skills/repo-c4-scan/scripts/validate_repo_c4.py repo-c4.json
git diff --check
```

Each stage close additionally requires:

- exact source, plan, MAP, routing, dependency, and artifact hashes;
- deterministic acceptance evidence and typed outputs;
- no unresolved reconciliation created by that stage;
- top-level architect-auditor verdict over an immutable packet;
- six isolated PASS receipts when the existing review barrier applies;
- owner scan for duplicated decisions and obsolete fallbacks;
- updated docs and C4 projection;
- files/lines added and removed, with custom-runtime delta explained;
- quantitative estimate of the active recovery/state/policy goal, delta from
  the previous checkpoint, and supporting evidence;
- quantitative estimate of the broader autonomous Geek goal, delta from the
  previous checkpoint, and supporting evidence;
- skipped checks and residual risks;
- authorized commit and push with `HEAD == tracking == advertised remote SHA`.

Without commit/push authority, the maximum state is
`READY_FOR_AUTHORIZED_PUBLISH`, not stage PASS. Live provider calls, paid runs,
publication, PRs, deployment, and credential changes require their own exact
approval.

## 13. Plan lock and amendment protocol

Before the first source mutation:

1. Verify every normative-package hash in immutable `PLAN_LOCK.json`, the source
   baseline HEAD, MAP identity, routing policy, and that only the hash-bound
   planning package differs from the source baseline.
2. Obtain explicit authority to start implementation and separately record the
   allowed commit/push/live scope.
3. Commit or otherwise anchor the planning package. Record the resulting
   `planAnchorCommit` only in the start receipt, never inside the package whose
   commit it identifies.
4. Atomically create immutable `IMPLEMENTATION_START.json` under the exact
   `implementation-start/v1` contract in `EVIDENCE_PROTOCOL.md`.
5. Make the progress verifier/ledger the first source slice. Append its genesis
   event rooted at the start receipt and regenerate JSONL/Markdown projections.
6. Reject any later mismatch as `blocked_plan_integrity`; no later stage begins
   until `STG-00` closes.

After start, this package is never edited. A normative change uses canonical
`amendments/AMD-NNNN.json` plus a human-readable `.md` projection. Ordinals are
strictly contiguous. `amendmentSha256` hashes canonical amendment bytes without
its digest; `effectivePlanSha256` is
`SHA256(canonical({baselinePlanSha256, previousEffectivePlanSha256, ordinal,
amendmentSha256}))`. Acceptance consumes exact amendment authority and appends
the acceptance, invalidation events, and newly eligible steps atomically. Exact
schemas, replay behavior, and receipt binding are in `EVIDENCE_PROTOCOL.md`.

An implementation detail within an existing contract may be appended to
`DECISIONS.md`; it cannot weaken a gate. A major objective change creates a new
plan ID. Already executed effects are compensated or reconciled, never erased
by rewriting history.

Progress checkboxes are projections, not authority. `[x]` requires evidence
bound to the exact effective plan, stage, step, source, command/oracle, inputs,
outputs, attempt, and terminal state. Invalidated evidence is preserved and a
new event returns the step to incomplete.

`PLAN_LOCK.json` is an immutable pre-start manifest and contains no mutable
start/acceptance booleans. Start state exists only when a valid create-if-absent
start receipt is present. Byte-identical replay is idempotent; any conflicting
second start receipt is `blocked_plan_integrity`.

## 14. Rollout decision thresholds

Hard gates:

- zero unauthorized writes;
- zero duplicate mutable effects in the crash matrix;
- 100% stale snapshot/input/memory detection before launch;
- 100% root/descendant usage coverage classified as exact, partial, or
  unavailable;
- zero provider/model/effort selection bypasses;
- zero orphan sessions after bounded recovery;
- no weakened approval, review, reconciliation, or MAP invariant.

Operational thresholds, measured on the locked local test environment:

- 100-node/400-edge pure validation and reduction p95 <= 50 ms;
- graph transition SQLite transaction p95 <= 50 ms at three concurrent
  read-only admissions, with zero surfaced unhandled `SQLITE_BUSY` failures;
- `collab_flow_status` and a 100-event page p95 <= 100 ms on a 100,000-event
  fixture;
- median legacy queue wait regression <= 20% against the `STG-00` baseline;
- redacted event payload body <= 4 KiB and checkpoint <= 256 KiB;
- 100,000-event fixture database growth <= 256 MiB;
- terminal-flow payload archival begins at 90 days or 1 GiB database size,
  whichever occurs first, while event headers/anchors remain queryable.

The hybrid path advances beyond shadow only if it also achieves one of:

- at least +10 percentage points verified completion with cost no greater than
  1.5 times the current flow; or
- equivalent verified completion with at least 25% lower median cost or wall
  time.

If neither threshold is met, retain the durable telemetry/typed-result
improvements that independently pass their gates and remove the unused Prime or
graph execution surface instead of maintaining a dormant fallback.

## 15. Assumptions and fixed decisions

- Version 1 is single-project per flow.
- Only read-only nodes may fan out concurrently.
- Conditions use terminal outcome or validated route enum only.
- Recursion is a separate immutable child flow; active graph mutation is
  forbidden.
- The current six-lane barrier remains the final independent review mechanism.
- The existing SQLite control plane remains authoritative.
- Prime Agent is an optional read-only execution adapter, not a workflow owner.
- The current ten reconciliation rows are operational debt, not migration PASS
  evidence.
