# Hybrid Agent Flow v1 R2 — Codex-required resilient collaboration

## Identity

- Plan ID: `agent-collab-hybrid-flow-v1-r2`
- Revision: `1.1.0`
- Status: `STABILIZED_READY_FOR_LOCK`
- Supersedes execution of `agent-collab-hybrid-flow-v1@1.0.1`; its files and evidence remain immutable.
- Source baseline: the Git anchor recorded in this revision's start receipt.
- Eval contract remains byte-identical: `561183ec6181e4d45e468a9b749ffc4f6791eebb9cce6d89d923bdf9bb5a6edd`.

## Inherited contract

All clauses, contracts, stages, schemas, limits, safety rules, and acceptance
criteria from `agent-collab-hybrid-flow-v1@1.0.1` remain normative except the
review availability clauses replaced below. The inherited package is bound by
the old `PLAN_LOCK.json` SHA-256
`c4a20714762f22e7ffe30b411483f822b4b447d634426b7603d5450ea8abf36b`.

## Required and optional harnesses

Codex is the required coordinator, stage owner, recovery owner, and minimum
review provider. Grok and Claude are optional diversity harnesses. Their
absence, quota exhaustion, authentication failure, timeout, crash, or disabled
state cannot block unrelated Codex-owned planning, execution, recovery,
verification, or stage closure.

Review closure requires exactly two terminal Codex lanes for the immutable
artifact: one auditor and one critic, both semantic `PASS`. A completed optional
lane with `CHANGES_REQUESTED` remains blocking until its finding is resolved or
invalidated by a newer artifact. Missing, unavailable, or never-admitted
optional lanes are recorded as `optional_unavailable` and are non-blocking.
An optional lane that launched but has ambiguous terminal evidence remains
subject to existing reconciliation and cannot be treated as unavailable.

## Automatic rejoin

Provider health remains broker-owned and durable. The broker probes unavailable
optional providers under the existing cooldown, lease, and explicit live-call
authority rules. When an optional provider becomes healthy, it is admitted to:

1. new review barriers;
2. pending optional lanes whose immutable artifact and source fingerprint are
   still current;
3. new ready read-only graph nodes eligible for diversity shadow execution.

Rejoin never mutates completed results, reopens a closed stage, duplicates an
attempt, consumes old authority, or changes the owner of an active Codex node.
Recovery is automatic from persisted health state; no process-local flag is an
authority source.

## New stage `R2-STG-00`

This stage precedes inherited `STG-01` and owns:

- the new lock/start/evidence chain;
- review barrier policy and projections in `src/domain/review.ts` and
  `src/runtime/run-gate-unit-of-work.ts`;
- provider health rejoin scheduling in `src/runtime/provider-health-store.ts`
  and the worker control loop;
- exact Codex-quorum, optional-failure, ambiguous-attempt, crash/restart, and
  automatic-rejoin tests;
- MCP status fields distinguishing required and optional provider availability.

Gate: Codex auditor+critic PASS closes a barrier while unavailable optional
lanes remain explicit; a launched ambiguous optional attempt still blocks; a
recovered optional provider is admitted exactly once to still-current pending
work. The existing safety, approval, MAP, idempotency, source-binding, and
reconciliation gates remain unchanged.

After `R2-STG-00`, execute inherited stages `STG-01` through `STG-12` in order.
Every inherited reference to a mandatory six-lane PASS is replaced by the
Codex-quorum rule above. All other stage-close evidence remains required.

## Acceptance scenarios

1. Given Grok and Claude unavailable before review admission, when Codex auditor
   and critic return PASS, then the stage may close and both optional lanes are
   projected as unavailable.
2. Given only Codex is healthy, when a full flow runs, then every mandatory
   stage, recovery action, and verification step completes through Codex.
3. Given an optional lane returns CHANGES_REQUESTED, when Codex lanes pass, then
   closure remains blocked until the finding is resolved against a new artifact.
4. Given an optional attempt launched and its result is ambiguous, when Codex
   lanes pass, then closure remains blocked by reconciliation.
5. Given an optional provider recovers, when pending current work exists, then
   it is admitted once without reopening completed work or changing Codex
   ownership.
6. Given a recovered provider fails again, when cooldown applies, then Codex
   continues and the optional provider returns to unavailable without a retry
   storm.
7. Given both optional providers stay unavailable, when graph and MCP evals run,
   then functional completeness is measured on the full Codex flow, with
   diversity coverage reported separately.

## Verification and publication

All commands and quantitative gates from the inherited plan remain mandatory.
Stage commits and push to `origin/master` are authorized by the user on
2026-08-31. Live provider work is capped at 24 launches and USD 10 total;
unreported cost is classified unknown and cannot exceed the cap by assumption.

