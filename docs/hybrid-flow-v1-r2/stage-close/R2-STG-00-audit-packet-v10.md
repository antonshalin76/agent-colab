# R2-STG-00 architect audit packet v10

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review
provider. Grok and Claude are optional diversity harnesses. Their absence,
quota, timeout, crash, disabled state, authentication failure, missing binary,
or missing skill root cannot block an otherwise valid Codex-owned flow. Safety,
permission denial, cancellation, invalid output, ambiguous launch, and
`needs_reconciliation` remain blocking.

## v9 receipt and root cause

The immutable v9 packet hash is
`dc673d4dc2ed94481119f8cf7bc23c3e8d040c4b8a19f2c5a2baf4e266c4814c`.
Exactly two read-only Codex lanes ran once. Auditor and critic independently
returned `CHANGES_REQUESTED` for the same defect and no additional finding:

- `AgentRunner` proves a synchronous missing-binary failure did not spawn and
  clears launch intent;
- the old clear operation erased the intent identity;
- review evidence accepted only `phase=started`, so exact optional
  `cli_missing` replayed indefinitely instead of becoming deferred.

The finding was treated as a missing state in the shared evidence protocol, not
as a special-case barrier bypass.

## Systemic correction

The durable launch evidence state is now explicit:

| State | Durable proof | Accepted review outcome |
|---|---|---|
| started | `launched=true`, `phase=started`, positive PID, exact launch identity | success or classified started-process outcome |
| proven no spawn | `launched=false`, `phase=proven_no_spawn`, no PID, exact preserved launch identity | `cli_missing` only |
| ambiguous | launching, blank, missing, contradictory, or mismatched evidence | blocking |

`RunStore.clearLaunchIntent` preserves agent, model, effort, policy, session,
and execution context while changing only the durable phase and removing any
PID/value. `RunGateUnitOfWork` validates the same immutable review/run/effect
identity for both states. Success still requires started evidence. A non-CLI
failover cannot be laundered through a prelaunch receipt.

This composes with the prior systemic recovery contract:

- terminal evidence is resolved before typed or textual failover evidence;
- accepted helper outage result and terminal time are independently projected
  onto the lane and revalidated on every barrier evaluation;
- a new attempt clears the prior projection atomically;
- deferred admission and rejoin require affirmative current harness readiness,
  provider health, pending barrier, and current source fingerprint.

No new queue, cache, scheduler, quorum calculator, process-local health owner,
database table, or schema migration was added.

## RED and GREEN evidence

- v9 live RED: both required Codex reviewers reproduced the same exact
  prelaunch-evidence defect.
- Deterministic RED against v9 production: the store lost proven-no-spawn
  identity and `recordProviderUnavailable` rejected the exact optional
  `cli_missing` run.
- Focused GREEN: 2 files, 64/64 PASS.
- Integration GREEN across store, worker, runner, barrier, service, rejoin, and
  outcome classification: 7 files, 197/197 PASS.
- Full deterministic repository gate: 51 files, 1235/1235 PASS in 394.58
  seconds.
- TypeScript typecheck, production build, `git diff --check`, and implementation
  progress verification: PASS.

Negative controls cover launched-flag mutation, `launching` substitution,
forged session, missing receipt, and a quota outcome attached to
`proven_no_spawn`. Every case remains blocking. Existing post-acceptance
payload/result/effect/time/status mutation and readiness/rejoin matrices remain
GREEN.

## Ownership and quantitative scope

| Decision | Sole owner | Failure behavior |
|---|---|---|
| launch/no-spawn evidence | `RunStore` launch fence | ambiguous state reconciles or blocks |
| terminal versus failover | shared outcome classifier | terminal wins |
| accepted optional outage | review UOW exact evidence predicate plus lane projection | mismatch blocks |
| review closure | `RunGateUnitOfWork.barrier` | non-exact or adverse evidence blocks |
| recovered lane admission | `RunGateUnitOfWork.activateDeferred` | missing readiness, health, or source proof blocks |

- Production source: 12 files, 362 additions, 77 removals.
- Tests: 12 files, 1060 additions, 54 removals.
- Total source and tests: 24 files, 1422 additions, 131 removals.
- Locked-plan progress remains 0 of 13 closed stages until this audit passes;
  frozen graph capability remains 0/12.
- Plan lock SHA-256:
  `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest:
  `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Live review launches are exhausted at 36/36. A v10 quorum requires separate
  authorization for exactly two more read-only Codex launches; the USD cap
  remains unchanged.

## Required verdict

Inspect the exact source, tests, systemic recovery document, and this immutable
packet. Return only canonical `review-verdict/v1` JSON with `PASS` or
`CHANGES_REQUESTED`.

Reject terminal-to-failover laundering, inference of no-spawn from absent
evidence, acceptance and closure derived from the same mutable run envelope,
missing readiness at authoritative admission, stale projection reuse,
transient closure, late reopening, helper substitution for Codex, or
contradictory complete MAP projections.
