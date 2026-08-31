# R2-STG-00 architect audit packet v11

## Binding system contract

Codex is the required coordinator, executor, recovery owner, and minimum review
provider. Grok and Claude are optional. Their absence cannot block an otherwise
valid Codex flow. Safety, permission denial, cancellation, invalid output,
ambiguous launch, contradictory durable evidence, and `needs_reconciliation`
remain blocking.

The evidence chain is one contract, not independent guards:

`persisted lane identity -> linked attempt/run -> launch receipt -> provider result/effect -> accepted lane projection -> monotonic lane state -> recomputed barrier`

## v10 receipts

The immutable v10 packet hash is
`4dc1be8f437247b9b202877dc894e09609c746b44fadf6b25786156b825bca26`.
Exactly two read-only Codex lanes ran once:

- auditor: `PASS`, no systemic defect found;
- critic: `CHANGES_REQUESTED`, two facets of one incomplete cross-binding
  invariant.

The critic showed that run-derived attempt identity was not independently
matched to the persisted current lane, and that an exact previously accepted
outage replay ceased to be idempotent after the legal transition from
`deferred` to `stale_artifact`.

## Systemic correction

`RunGateUnitOfWork` now uses two shared predicates at acceptance and closure:

1. `attemptMatchesLaneIdentity` binds model, effort, policy, reasons, session,
   and idempotency key from the persisted lane to the linked attempt before any
   run payload or launch evidence is trusted.
2. `matchesAcceptedUnavailableProjection` binds the sanitized provider result
   and terminal time to the independently persisted lane projection.

The complete state semantics are:

| State/evidence | Allowed transition or closure effect |
|---|---|
| exact started run | normal success or classified started-process outcome |
| exact `proven_no_spawn` | `cli_missing` only |
| exact accepted outage in `deferred` | replay is an idempotent no-op |
| exact accepted outage in `stale_artifact` | replay is an idempotent no-op; lane remains stale |
| lane/attempt mismatch | barrier blocks |
| coordinated payload plus launch mutation without matching persisted lane | barrier blocks |
| missing, launching, contradictory, or forged evidence | barrier blocks |

This is additive to the earlier terminal-first classifier, independent accepted
outage projection, readiness-gated admission, source-fingerprint rejoin, and
new-attempt projection clearing. No provider-specific exception or
benchmark-specific branch was introduced.

No new queue, cache, scheduler, quorum calculator, process-local health owner,
database table, schema migration, or duplicate receipt store was added.

## RED and GREEN evidence

- v10 live RED: critic reported the lane/run cross-binding and stale replay
  facets; auditor found no additional defect.
- Deterministic RED: six manifestations across lane effort, reasons, session,
  idempotency mutation, coordinated run payload plus launch mutation, and exact
  stale replay.
- Focused GREEN: 1 file, 53/53 PASS.
- Integration GREEN across store, worker, runner, barrier, service, rejoin, and
  outcome classification: 7 files, 197/197 PASS.
- First full rerun was not accepted: 50/51 files and 1234/1235 tests passed,
  while a mutation test exceeded 15 seconds under full load.
- The test was split by invariant ownership into run/effect and
  lane/attempt/run identity tests. No timeout was increased and no assertion
  was removed.
- Final deterministic repository gate: 51 files, 1236/1236 PASS in 430.07
  seconds.
- TypeScript typecheck, production build, `git diff --check`, and implementation
  progress verification: PASS.

The human-readable R2 checklist is
`docs/hybrid-flow-v1-r2/IMPLEMENTATION_PROGRESS.md`. It distinguishes eight
evidence-backed readiness gates from the still-open live receipts, barrier,
durable progress event, and publication gates. Its checkboxes do not replace
the start-rooted progress ledger.

## Quantitative scope

- Production source: 12 files, 381 additions, 78 removals.
- Tests: 12 files, 1137 additions, 54 removals.
- Total source and tests: 24 files, 1518 additions, 132 removals.
- Locked-plan progress remains 0 of 13 closed stages until this audit passes;
  frozen graph capability remains 0/12.
- Plan lock SHA-256:
  `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest:
  `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- The immutable start receipt records the original 24-launch authority. Later
  user approvals increased that ceiling in exact two-launch increments. The
  final v11 auditor-plus-critic quorum is authorized at 40/40; the USD 10 cap
  remains unchanged. No further launch-cap increase is permitted.

## Required verdict

Inspect the exact source, tests, systemic recovery document, and this immutable
packet. Return only canonical `review-verdict/v1` JSON with `PASS` or
`CHANGES_REQUESTED`.

PASS requires one consistent evidence protocol across store, worker, replay,
lane projection, barrier, and rejoin. Reject local exceptions, identity derived
only from mutable run data, non-monotonic replay, terminal-to-failover
laundering, inferred no-spawn, helper substitution for Codex, or contradictory
complete MAP projections.
