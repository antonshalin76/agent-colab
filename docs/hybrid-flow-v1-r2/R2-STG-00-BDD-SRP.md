# R2-STG-00 BDD and SRP evidence

## Scenarios

- `R2-CQ-01`: Given only Codex is healthy, when Codex auditor and critic produce exact semantic PASS receipts, then the barrier is satisfied while four optional lanes remain deferred.
- `R2-CQ-02`: Given Codex is unavailable, when helper lanes pass, then the barrier remains unsatisfied.
- `R2-CQ-03`: Given Codex passes and a completed optional lane requests changes, then the barrier remains unsatisfied.
- `R2-CQ-04`: Given Codex passes and an optional launched attempt needs reconciliation, then the barrier remains unsatisfied.
- `R2-CQ-05`: Given an optional provider recovers while its artifact is current, when rejoin runs, then its deferred lanes are admitted exactly once.
- `R2-CQ-06`: Given an optional provider recovers after source drift, when rejoin runs, then its lanes become stale and no run is enqueued.
- `R2-CQ-07`: Given Codex emits a required skill announcement before its terminal response, when the transport normalizes the stream, then only the last completed assistant message reaches the strict verdict parser.
- `R2-CQ-08`: Given the required Codex barrier is already satisfied, when an optional provider recovers, then rejoin does not reopen or enqueue the completed review.
- `R2-CQ-09`: Given a helper attempt is scheduled, when Codex produces its required PASS receipts, then closure waits for the bounded helper terminal state and cannot transiently pass then reopen.
- `R2-CQ-10`: Given a helper terminates, when its outcome is classified, then only explicit quota, rate, overload, timeout, missing CLI, authentication, or model availability outcomes are non-blocking; malformed, task, invalid, safety, permission, and cancellation outcomes block.
- `R2-CQ-11`: Given canonical terminal enum evidence is mixed with any failover marker, when the shared classifier evaluates it, then the terminal enum wins; unsupported-model evidence also wins over quota and rate-limit markers.
- `R2-CQ-12`: Given a helper failover result is durably completed, when its persisted review effect conflicts with the immutable review, attempt, role, agent, result kind, terminal time, or run payload, then the lane remains blocking and cannot become deferred.
- `R2-CQ-13`: Given Codex is healthy and optional harnesses are unavailable or disabled, when their skill roots are absent, then delegation and review continue through Codex; a required Codex skill-root mismatch still fails closed.
- `R2-CQ-14`: Given a typed provider transport failure declares a failover outcome but carries a canonical terminal token or unsupported-model evidence, when the shared classifier evaluates it, then the terminal evidence wins.
- `R2-CQ-15`: Given an optional attempt was accepted as exactly unavailable and its persisted run payload or effect is later corrupted, when the barrier is recomputed, then the lane becomes blocking again.
- `R2-CQ-16`: Given a helper provider recovers but current shared-skill readiness is absent rather than affirmatively true, when rejoin runs, then no deferred lane is activated.
- `R2-CQ-17`: Given an optional harness binary is synchronously absent and the launch fence proves that no process spawned, when `cli_missing` is durably replayed, then the lane becomes non-blocking; a blank, launching, forged, or non-CLI prelaunch receipt remains blocking.
- `R2-CQ-18`: Given an accepted optional outage, when persisted lane identity or a coordinated run-payload plus launch identity is mutated, then the independently cross-bound evidence no longer satisfies the barrier.
- `R2-CQ-19`: Given an accepted outage lane legally became `stale_artifact`, when the exact domain effect is replayed, then replay is an idempotent no-op and can become applied without reactivating the lane; mismatched evidence still fails closed.

BDD critic (self-review): `PASS`. Helper success cannot substitute for Codex; optional unavailability is distinct from adverse or ambiguous evidence.

BDD auditor (self-review): `PASS`. Codex quorum, recovery, source binding, exact evidence, and reconciliation are mapped to deterministic store seams.

v7 BDD critic (separate self-review): `PASS`. The new scenarios distinguish canonical tokens from prose aliases, exact effect identity from result-only matching, and optional installation state from required Codex readiness.

v7 BDD auditor (separate self-review): `PASS`. `R2-CQ-11` maps to the shared outcome classifier, `R2-CQ-12` to the durable review unit of work, and `R2-CQ-13` to service admission with provider health.

v8 BDD critic (separate self-review): `PASS`. The scenarios distinguish typed failover metadata from terminal message evidence, admission-time validation from closure-time evidence, and explicit readiness from missing readiness.

v8 BDD auditor (separate self-review): `PASS`. `R2-CQ-14` maps to the shared typed-failure classifier, `R2-CQ-15` to barrier recomputation over current durable evidence, and `R2-CQ-16` to the worker rejoin boundary.

v9 BDD auditor and critic: `CHANGES_REQUESTED`. Both independently identified the same missing durable boundary between proven synchronous no-spawn and ambiguous launch intent; no additional finding was reported.

v10 BDD critic (separate self-review): `PASS`. `R2-CQ-17` requires an affirmative `proven_no_spawn` receipt with exact launch identity and rejects inference from `launched=false` alone.

v10 live auditor: `PASS`. v10 live critic: `CHANGES_REQUESTED`. The critic found two facets of one incomplete cross-binding contract: lane identity was not independent from run-derived attempt identity, and accepted replay was not monotonic after `stale_artifact`.

v11 BDD critic (separate self-review): `PASS`. `R2-CQ-18` and `R2-CQ-19` require the same authoritative evidence predicate at acceptance and closure, with explicit monotonic post-acceptance replay semantics.

## Scenario-to-test evidence

| Scenario | Deterministic seam | Result |
|---|---|---|
| `R2-CQ-01` | `runtime-review-barrier.test.ts`: exact Codex quorum with Grok unavailable and Claude disabled | PASS |
| `R2-CQ-02` | `runtime-review-barrier.test.ts`: helper PASS cannot replace Codex | PASS |
| `R2-CQ-03` | exact optional `CHANGES_REQUESTED` runner evidence keeps the barrier closed | PASS |
| `R2-CQ-04` | optional launched run moved to `needs_reconciliation` after Codex PASS | PASS |
| `R2-CQ-05` | provider cooldown recovery admits a current deferred lane once; successful probe immediately admits the remainder | PASS |
| `R2-CQ-06` | source fingerprint drift produces `stale_artifact` and no run | PASS |
| `R2-CQ-07` | `runner-commands.test.ts`: a separate skill announcement cannot corrupt the terminal verdict JSON | PASS |
| `R2-CQ-08` | wrapper, direct UOW, competing UOW, and idempotent service replay: a satisfied Codex barrier is rejected before admission and again atomically inside activation | PASS |
| `R2-CQ-09` | scheduled optional attempts keep the barrier closed; canonical timeout effects become exactly verified `provider_unavailable` attempts before Codex closure | PASS |
| `R2-CQ-10` | five adverse/availability collision cases fail closed; malformed/incomplete transport output remains terminal; exact timeouts remain non-blocking | PASS |
| `R2-CQ-11` | canonical terminal-token collision table plus unsupported-model/rate and quota cases | PASS |
| `R2-CQ-12` | exact persisted timeout effect identity with field-by-field negative mutations | PASS |
| `R2-CQ-13` | Codex-only delegation and review with missing optional skill roots; required Codex mismatch negative control; rejoin readiness gate | PASS |
| `R2-CQ-14` | typed `ProviderTransportFailure` collisions with canonical terminal and unsupported-model evidence | PASS |
| `R2-CQ-15` | post-admission mutation of persisted unavailable-run evidence blocks the barrier | PASS |
| `R2-CQ-16` | missing affirmative harness readiness cannot activate deferred work | PASS |
| `R2-CQ-17` | exact prelaunch `cli_missing` closes optional lanes; launched flag, phase, session, missing receipt, and non-CLI failover negative controls remain blocking | PASS |
| `R2-CQ-18` | lane effort/reasons/session/idempotency mutations and coordinated run payload+launch mutation close the barrier | PASS |
| `R2-CQ-19` | exact replay after source-stale transition is accepted without state change; wrong terminal receipt is rejected | PASS |

RED evidence:

- old six-lane quorum rejected Codex-only completion with `requiredCount: 6`;
- `LocalCollabService.status()` returned no `reviewPolicy`;
- an integrity test exposed that a forged `completed -> failed` optional lane could be mistaken for an ordinary provider failure.

GREEN evidence:

- `npx vitest run tests/runtime-review-barrier.test.ts tests/review-lanes.test.ts tests/provider-health-store.test.ts tests/collaboration-runtime.test.ts tests/workflow.test.ts`: 82/82 PASS;
- `npx vitest run tests/runtime-review-barrier.test.ts tests/app-service.test.ts tests/mcp.test.ts`: 62/62 PASS;
- reviewer-correction regression set for crash window, malformed output, rejoin isolation, Codex priority, and provider identity: 6/6 PASS;
- final correction integration set: 8 files, 167/167 PASS;
- terminal-message and completed-work rejoin regression set: 3 files, 80/80 PASS;
- v4 correction integration set: 5 files, 125/125 PASS;
- v5 correction integration set: 6 files, 145/145 PASS;
- v6 correction focused set: 2 files, 92/92 PASS;
- v6 correction integration set: 6 files, 133/133 PASS;
- v7 correction focused set: 4 files, 134/134 PASS;
- v7 correction integration set: 7 files, 161/161 PASS;
- systemic recovery RED: 21 failure manifestations across seven typed terminal collisions, eleven post-acceptance mutations, two authoritative-admission readiness cases, and one wrapper missing-readiness case;
- systemic recovery focused set: 3 files, 119/119 PASS;
- systemic recovery integration set: 7 files, 167/167 PASS;
- v9 recovery RED: exact synchronous no-spawn identity was erased and the review barrier rejected the resulting optional `cli_missing` effect;
- v9 recovery focused set: 2 files, 64/64 PASS;
- v9 recovery integration set: 7 files, 197/197 PASS;
- v10 recovery RED: six manifestations across four lane-identity mutations, one coordinated run mutation, and stale accepted-receipt replay;
- v10 recovery focused set: 1 file, 53/53 PASS;
- v10 recovery integration set: 7 files, 197/197 PASS;
- first full repository rerun: 50/51 files and 1234/1235 tests passed; the combined mutation test exceeded its 15-second limit under full load, so no PASS was claimed;
- mutation concerns split into independent run/effect and lane/attempt identity tests without raising timeouts;
- final repository suite: 51 files, 1236/1236 PASS in 430.07 seconds;
- `npm run typecheck`: PASS.

Test-design critic (self-review): `PASS`. Tests exercise durable SQLite rows, exact runner receipts, health admission, source binding, and reconciliation. No provider process is mocked into a synthetic PASS.

## Ownership

| Slice | Owner | Reason to change |
|---|---|---|
| quorum decision | `RunGateUnitOfWork.barrier` | required-provider policy changes |
| immutable review persistence | `RunGateUnitOfWork` | lane/attempt durability and accepted-outcome projection changes |
| provider availability | `ProviderHealthStore` | health/cooldown/lease policy changes |
| rejoin scheduling | worker control loop | deferred-work scheduling changes |
| MCP projection | `LocalCollabService` | external status contract changes |
| UI | N/A | no UI |

Pre-RED SRP self-audit: `PASS`. No adapter, worker, or MCP handler independently recomputes quorum.

Final SRP self-audit: `PASS`. `REVIEW_BARRIER_POLICY` owns provider roles, `RunGateUnitOfWork.barrier()` owns closure, the worker owns scheduling, and `LocalCollabService` only projects the policy. The MCP adapter transports the projection unchanged.

## Final service-slice ownership

| Slice | Authoritative owner | Adapter or N/A |
|---|---|---|
| functionality | `RunGateUnitOfWork.barrier()` | MCP does not decide quorum |
| persistence | `RunGateUnitOfWork` plus `RunStore` transaction | N/A |
| state transitions | `ProviderHealthStore` and durable review attempt state | worker invokes transitions |
| audit evidence | exact runner envelope and attempt rows | status projects counts and policy |
| UI state | N/A | no UI |
| broker/proxy decisions | worker health admission and recovery loop | MCP does not route providers |

Post-refactor scan: no second quorum calculator, process-local availability authority, cache, Redis dependency, alternate queue, or schema migration was added. Canonical optional failover outcomes are non-blocking only while persisted lane identity, linked attempt/run, payload, launch, effect, result-kind, terminal-time, and independently persisted accepted projection all match. Exact started evidence remains required except for synchronous `cli_missing`, which requires the separate `proven_no_spawn` launch-intent receipt; absence of launch evidence is never treated as proof. Exact accepted outage replay is monotonic and idempotent in both `deferred` and `stale_artifact`; it never reactivates stale work. A new attempt atomically clears the prior lane outcome. Raw or mismatched `failed` and `timed_out` states block. Canonical and semantic terminal evidence plus unsupported-model evidence take precedence over typed or textual failover markers. Durable inconsistency, malformed successful output, crash-window terminal mismatch, and `needs_reconciliation` remain blocking. Required Codex review runs have queue priority 4; optional runs use priority 20, below ordinary Codex workflow work. Shared-skill readiness is distinct from provider health and is now required by the authoritative deferred-lane admission method: Codex readiness is required, missing optional roots make only their harness unavailable, and the worker rechecks readiness before rejoin. Repeated provider failures use a one-hour-capped exponential cooldown. A recovered helper can join only while the exact review barrier remains pending; satisfied and source-drift transitions are guarded atomically.

Owned source and test delta against the source baseline: 24 files, 1518 added lines, 132 removed lines. Production source accounts for 12 files, 381 additions, and 78 removals; tests account for 12 files, 1137 additions, and 54 removals. R2 adds a product capability and durable evidence tooling; no obsolete parallel implementation remains.
