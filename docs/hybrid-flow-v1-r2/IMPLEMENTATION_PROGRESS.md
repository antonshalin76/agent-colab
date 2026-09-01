# Hybrid Agent Flow v1 R2 — implementation progress

This mutable document is a human-readable projection of the immutable R2 plan
and its verified evidence. It has no authority to close a gate. A stage is
complete only when a valid start-rooted `PlanProgressEvent/v1` exists and the
progress verifier accepts the complete chain.

## Lock and admission

- [x] `R2-LOCK-01` The immutable plan and lock hashes match the anchor.
- [x] `R2-LOCK-02` The R2 start receipt is bound to the source baseline, MAP,
  routing policy, and separate authority scopes.
- [x] `R2-LOCK-03` The progress verifier accepts the R2 package with zero
  completion events.
- [x] `R2-LOCK-04` Codex is required; Grok and Claude are optional and cannot
  block a valid Codex-only flow solely because they are unavailable.
- [x] `R2-LOCK-05` The final live certification budget is fixed at 40 launches
  and USD 10; no further launch-cap increase is permitted.

## `R2-STG-00` readiness

- [x] `R2-STG-00` Provider availability, recovery, evidence, and review barrier
  stage is closed.
  - [x] `R2-STG-00-G1` Terminal-first provider failure classification is
    implemented and collision-tested.
  - [x] `R2-STG-00-G2` Exact launch, `proven_no_spawn`, result, effect, and
    independent accepted-outage projection are cross-bound.
  - [x] `R2-STG-00-G3` Persisted lane identity is bound to attempt and run
    identity before mutable run evidence is trusted.
  - [x] `R2-STG-00-G4` Exact accepted outage replay is idempotent across the
    legal `deferred` to `stale_artifact` transition; contradictory replay
    blocks.
  - [x] `R2-STG-00-G5` Admission and automatic rejoin require exact harness
    readiness, health, artifact, source fingerprint, and current barrier.
  - [x] `R2-STG-00-G6` Optional-provider absence does not substitute a helper
    for Codex and does not block the full Codex flow.
  - [x] `R2-STG-00-G7` Focused gate passes 53/53; integration gate passes
    197/197; repository gate passes 1236/1236.
  - [x] `R2-STG-00-G8` Typecheck, production build, diff check, immutable-plan
    verification, and local independent architect audit pass.
  - [x] `R2-STG-00-G9` Final immutable-artifact Codex auditor receipt is
    semantic `PASS`.
  - [x] `R2-STG-00-G10` Final immutable-artifact Codex critic receipt is
    semantic `PASS`.
  - [x] `R2-STG-00-G11` The barrier recomputes closed with optional unavailable
    lanes explicit and no reconciliation-required attempt.
  - [x] `R2-STG-00-G12` A start-rooted stage-close progress event is recorded
    and verified.
  - [x] `R2-STG-00-G13` The exact reviewed source is committed and pushed to
    `origin/master`.

## Inherited stages

- [x] `STG-01` Immutable graph and result contracts.
- [x] `STG-02` Deployed compatibility runtime.
- [ ] `STG-03` Additive schema v4.
- [ ] `STG-04` Event/session telemetry on the linear path.
- [ ] `STG-05` Typed node results and session checkpoints.
- [ ] `STG-06` Pure reducer and shadow scheduler.
- [ ] `STG-07` Node-time admission dry run.
- [ ] `STG-08` Sequential graph execution bridge.
- [ ] `STG-09` Read-only fan-out, fan-in, joins, and conditional routes.
- [ ] `STG-10` Additive MCP flow API.
- [ ] `STG-11` Prime Agent read-only shadow adapter.
- [ ] `STG-12` Paired evaluation, cutover decision, and cleanup.

## Current measured progress

- Closed implementation stages: `3/13`.
- `R2-STG-00` readiness gates with evidence: `13/13`.
- Frozen graph capability stages closed: `2/12`.
- Deterministic graph eval capability: `12/12` PASS on the candidate versus
  `0/12` PASS on baseline SHA `d0f6cda738cf08ff851f14192ff48e636c1f0f17`.
- Stage checkboxes remain open until their mandatory architect audit,
  stage-close evidence, commit, and push gates are satisfied; functional eval
  success is not substituted for formal stage closure.
- Current repository gate: `68/68` files and `1550/1550` tests PASS; the older
  numeric minima in G7 remain satisfied by the larger current suite.
- Exact reviewed R2 source: `1e652ef1e48d7cc7487c7cea21e79554a839b1ee`,
  pushed to `origin/master`.
- Exact reviewed STG-01 source: `b31a83917182ef4d406040e74e9fb31c42f6570e`,
  pushed to `origin/master`; progress event `98e901f40784a4b7d2bba23847b80e491f808eb710e14f9ce2fc59f070bb8b97`.
- Exact reviewed STG-02 source: `2f10c719690063cf2546e16fb21dadefd2610f6b`,
  pushed to `origin/master`; progress event `924887cd4205a7b5b9a9fabad426162d32c3ec6da886eff24b8bc074ba0c5469`.
- Review topology is six explicit lanes: an auditor and critic from each of
  Codex, Grok, and Claude. The Codex pair is required; each optional pair is
  admitted automatically when healthy and cannot block a Codex-only flow while
  unavailable.
- Production runtime remains under unconditional quarantine until the certified
  STG-12 cutover.
- Next authoritative transition: execute inherited `STG-03` through `STG-12`
  in immutable order.
