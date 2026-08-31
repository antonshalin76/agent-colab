# R2-STG-00 systemic recovery pass

This document constrains execution of the locked R2-STG-00 stage. It does not
change `IMPLEMENTATION_PLAN.md`, `EVIDENCE_PROTOCOL.md`, or `PLAN_LOCK.json`.

## Root cause

Provider failure classification, durable review evidence, and recovered-lane
admission were checked at different boundaries with different inputs:

- typed transport metadata could bypass terminal message evidence;
- accepted `provider_unavailable` evidence was not retained in the lane
  projection, so later barrier evaluation compared values derived from the same
  mutable run envelope;
- shared-skill readiness was required by selected callers rather than by the
  authoritative deferred-lane admission operation.
- the durable runner contract erased the launch-intent identity after a proven
  synchronous no-spawn, while review evidence accepted only started-process
  receipts. Exact optional `cli_missing` therefore replayed forever.
- exact run evidence could reconstruct decision identity from the linked run
  without independently matching the persisted current lane identity;
- an accepted outage receipt was replay-idempotent while `deferred`, but not
  after the legal monotonic transition to `stale_artifact`.

These are one defect class: a decision was accepted without a durable,
recomputable invariant at its authoritative owner.

## Invariants and owners

| Invariant | Authoritative owner | Durable inputs |
|---|---|---|
| terminal evidence always precedes failover evidence | `classifyProviderFailureDetail` | typed outcome, error text, stderr |
| a helper outage is non-blocking only while its exact run still matches the accepted lane outcome | `RunGateUnitOfWork` | immutable review/attempt, run payload/launch/effect, lane error/terminal projection |
| no helper lane is admitted without affirmative current skill readiness | `RunGateUnitOfWork.activateDeferred` | required boolean readiness, provider health, source fingerprint, barrier state |
| a new attempt cannot inherit an earlier terminal projection | `RunGateUnitOfWork.activateDeferred` | lane CAS transition |
| source drift and satisfied barriers cannot be reopened | `RunGateUnitOfWork.activateDeferred` | current fingerprint and recomputed barrier |
| proven no-spawn is distinct from both started and ambiguous launch | `RunStore` plus `RunGateUnitOfWork` | launch intent identity, explicit `proven_no_spawn` phase, result/effect envelope |
| current closure identity is independently cross-bound | `RunGateUnitOfWork` | persisted lane identity, linked attempt/run, launch receipt, result/effect |
| accepted outage replay is monotonic across post-acceptance states | `RunGateUnitOfWork.recordProviderUnavailable` | accepted lane projection, exact run evidence, `deferred` or `stale_artifact` state |

## State and evidence contract

1. The worker classifies a provider result once through the shared classifier.
2. `recordProviderUnavailable` validates the complete run identity and effect
   against the immutable review and active attempt.
3. The same transaction changes the lane to `deferred` and persists the
   sanitized provider result plus terminal time in the existing lane
   projection.
4. Every barrier evaluation recomputes exact run identity and compares the
   current run envelope with that independent accepted lane projection.
5. Any later run, payload, launch, result, effect, identity, kind, or time
   mismatch makes the optional lane blocking.
6. Source-stale lanes retain their last accepted provider outcome; a new queued
   attempt atomically clears the previous result, error, and terminal time.
7. Deferred admission requires `harnessReady === true` inside the unit of work
   before provider-health acquisition or lane mutation.
8. Clearing a launch intent after a synchronous launcher failure preserves the
   exact agent/model/effort/policy/session identity with
   `phase=proven_no_spawn`; it does not infer absence from a blank row.
9. Only an exact `cli_missing` result can use this prelaunch receipt. Success
   still requires a started PID, other failover kinds require started evidence,
   and a launching/blank/mismatched receipt remains blocking.
10. Every current barrier and outage acceptance compares lane model, effort,
    policy, reasons, session, and idempotency identity with the linked attempt
    before trusting its run payload or launch receipt.
11. An exact previously accepted outage replay is a no-op in both `deferred`
    and `stale_artifact`. It cannot reactivate stale work, overwrite the
    projection, or leave the domain effect pending forever.

## Rejected alternatives

- Rechecking terminal time against `ReviewAttemptSnapshot.terminalAt` is
  invalid because that value is derived from the same mutable run effect.
- Adding a second quorum calculator or wrapper-only readiness guard would
  duplicate authority.
- Adding receipt columns to `runtime_review_lane_attempts` would require a new
  live schema migration while the existing lane projection already owns the
  current outcome.
- Treating the v8 auditor process failure as PASS or provider unavailability is
  forbidden; the mandatory Codex quorum remains incomplete.
- Treating `launched=false` alone as no-spawn evidence is forbidden because it
  cannot distinguish a cleared launch intent from a run that never reached the
  launch fence.

## One-pass validation matrix

- Typed failover metadata crossed with every canonical terminal token and
  unsupported-model evidence.
- Post-acceptance mutation of run payload, launch identity, provider result,
  review/attempt/role/agent/result-kind identity, terminal time, and run status.
- Direct admission and worker rejoin with readiness `true`, `false`, and
  missing-at-runtime negative control.
- Source-current recovery, source drift, satisfied barrier, stale older result,
  concurrent activation, and provider cooldown.
- Existing Codex-only service delegation/review with optional skill roots
  absent and required Codex root negative control.
- Exact synchronous `cli_missing` no-spawn receipts, ambiguous launch intent,
  missing receipt, forged phase/session, launched-flag mutation, and non-CLI
  failover laundering through a prelaunch receipt.
- Independent lane identity mutation, coordinated run-payload plus launch
  mutation, exact stale replay, corrupted stale replay, and preservation of the
  monotonic `stale_artifact` state.
- Focused tests, integration set, full deterministic suite, typecheck, build,
  diff check, progress verifier, service restart, and one final live Codex
  auditor-plus-critic quorum after separate launch authorization.

No production edit is accepted until the complete matrix is RED against the
old behavior where applicable and GREEN after one coherent implementation.
