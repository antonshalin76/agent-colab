# Hybrid Agent Flow v1 — risk register

| ID | Risk | Probability | Impact | Mitigation | Validation signal |
|---|---|---:|---:|---|---|
| `R-01` | Result transition and downstream admission are partially committed | Medium | Critical | Separate atomic `GraphResultUoW` intent and `NodeAdmissionUoW` dispatch boundaries with CAS | Fault injection produces one accepted result, intent, workflow, and dispatch per node |
| `R-02` | Fan-out increases SQLite writer contention | Medium | High | Short CAS transactions; no external calls in transaction; concurrency cap | Queue wait and busy-time distributions remain within the stage budget |
| `R-03` | Text output is accepted as typed success | Medium | High | Ajv validation before result acceptance; no prose fallback | Invalid/malformed outputs never activate an edge |
| `R-04` | Early snapshot or authority is reused after drift | Medium | Critical | JIT node admission and final pre-launch revalidation | Source/input/memory/MAP mutation blocks launch without extra consumption |
| `R-05` | Session memory leaks across flow/project boundaries | Low | Critical | Composite scope keys, bounded manifests, negative retrieval tests | Cross-flow and cross-project reads return no records |
| `R-06` | Usage aggregation double-counts descendants | Medium | Medium | Explicit `self/subtree/unknown` scope and nullable provenance | Fixture tree totals match hand-calculated totals |
| `R-07` | Event ledger grows without bound or archival breaks its chain | High | Medium | Permanent headers/hash anchors; separable bounded payload archive | 100k growth/query gates pass and archived chain verifies end-to-end |
| `R-08` | Prime Agent bypasses permissions through Python or shell | High | Critical | Read-only sealed environment; deny unsafe RPC features; no mutable lane | Write/model-switch/schedule/refinement probes are denied and recorded |
| `R-09` | Compatibility path becomes a permanent duplicate runtime | Medium | High | Expiry in `STG-12`; owner scan and code-surface gate | One authority path remains after cutover/rejection |
| `R-10` | v4 rollback loses post-backup legacy or graph writes | Medium | Critical | Deploy compatibility first; external fsync'd hash-chain restore guard plus epoch/digests | Physical restore is blocked after reopen/write even when no graph row exists |
| `R-11` | Manual progress edits create false completion | Medium | High | Start-rooted pre-v4 receipts, then canonical SQLite; Markdown is generated | Negative control resets forged checkbox and rejects broken evidence chain |
| `R-12` | Partial review is mistaken for full PASS | Medium while Grok is probing | High | Preserve exact six-lane barrier and `DEGRADED_REVIEW_SET` | Stage close refuses fewer than six semantic PASS receipts |
| `R-13` | Existing reconciliation debt is treated as migration success | High | High | Classify each row; never infer terminal outcome | No unresolved row is converted or counted as PASS |
| `R-14` | Graph library or schema validator drifts after lock | Low | Medium | Exact dependency versions and lockfile; amendment on change | Dependency manifest equals the locked versions |
| `R-15` | Concurrent nodes oversubscribe token/cost ceilings | Medium | Critical | Atomic worst-case reservations; unavailable usage remains charged | Racing admissions never exceed the flow reservation ceiling |
| `R-16` | Later mutable node has no exact authority path | High | Critical | `awaiting_authority` plus exact `collab_flow_admit_node` binding | Wrong node/revision/hash approval is rejected and never retained |
| `R-17` | Cancellation hides ambiguous mutable effects | Medium | Critical | Requester/origin authorization and reconciliation terminal rules | Ambiguous attempts never become cancelled-success or retry automatically |
| `R-18` | Prime becomes a second routing identity | Medium | Critical | Broker-owned adapter policy below routing-v5; shadow only | Prime absent from agent/review/origin/failover enums and authoritative results |
| `R-19` | Cross-flow foreign keys leak or misattribute result/usage/archive data | Low | Critical | Composite flow-scoped keys and executable negative inserts | Every cross-flow result/session/usage/coverage/archive insert is rejected |
| `R-20` | MCP mutation replay duplicates effects after restart | Medium | Critical | Durable canonical request/terminal response idempotency ledger | Same bytes replay identically; conflicting bytes reject before mutation |

## Residual risks accepted for version 1

- A privileged local user can rewrite the repository and all local hashes; an
  authorized Git commit/remote SHA is the optional external anchor.
- Prime Agent remains a fast-moving external runtime. The adapter is therefore
  isolated, read-only, pinned, and removable.
- Version 1 does not optimize arbitrary quorum or speculative mutable execution.
- Historical legacy workflows without typed outputs remain historical rather
  than being reconstructed into graphs.
