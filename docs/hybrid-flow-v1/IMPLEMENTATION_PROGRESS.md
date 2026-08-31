# Hybrid Agent Flow v1 — progress ledger

This file is mutable. It projects progress against immutable plan
`agent-collab-hybrid-flow-v1@1.0.1`. Canonical evidence starts as immutable
start-rooted pre-v4 receipts and is atomically imported into SQLite
`plan_progress_events` at `STG-03`; JSONL and this Markdown file are exports. Until
the `STG-00` verifier exists and passes, every checkbox is an
`UNVERIFIED_PROJECTION` and must remain empty.

## Lock state

- [ ] `LOCK-01` Exact plan SHA matches `IMPLEMENTATION_PLAN.sha256`.
- [ ] `LOCK-02` Lock manifest, repository identity, MAP identity, and routing
  policy verified.
- [ ] `LOCK-03` Explicit implementation authority recorded.
- [ ] `LOCK-04` Commit/push/live-provider scopes recorded separately.
- [ ] `LOCK-05` `IMPLEMENTATION_START.json` created and verified.

## Stage progress

- [ ] `STG-00` Plan frozen and execution admitted.
  - [ ] `STG-00-G1` No source mutation preceded the start manifest.
  - [ ] `STG-00-G2` Active and reconciliation rows classified.
  - [ ] `STG-00-G3` Start/progress/amendment verifier negative controls pass.
- [ ] `STG-01` Immutable graph and result contracts.
  - [ ] `STG-01-G1` Contract and negative-control tests pass.
  - [ ] `STG-01-G2` No runtime behavior changed.
- [ ] `STG-02` Deployed compatibility runtime.
  - [ ] `STG-02-G1` v3/v4 reopen and legacy compatibility pass.
  - [ ] `STG-02-G2` Authorized deploy/restart/reopen receipt exists.
- [ ] `STG-03` Additive schema v4.
  - [ ] `STG-03-G1` Backup/migration/rollback/fault gates pass.
  - [ ] `STG-03-G2` Populated v3 evidence and write epoch are preserved.
- [ ] `STG-04` Event/session telemetry on the linear path.
  - [ ] `STG-04-G1` Usage provenance and aggregation tests pass.
  - [ ] `STG-04-G2` Redaction, archival, and exporter-failure tests pass.
- [ ] `STG-05` Typed node results and session checkpoints.
  - [ ] `STG-05-G1` Result/input/terminal-envelope schema gates pass.
  - [ ] `STG-05-G2` Memory isolation/compaction/tamper gates pass.
- [ ] `STG-06` Pure reducer and shadow scheduler.
  - [ ] `STG-06-G1` Readiness parity passes.
  - [ ] `STG-06-G2` CAS/crash/replay tests show no duplicate intent.
- [ ] `STG-07` Node-time admission dry run.
  - [ ] `STG-07-G1` JIT source/input/MAP/authority/budget gates pass.
  - [ ] `STG-07-G2` No graph provider dispatch is possible.
- [ ] `STG-08` Sequential graph execution bridge.
  - [ ] `STG-08-G1` Legacy-equivalence evidence passes.
  - [ ] `STG-08-G2` No duplicate workflow, authority, budget, or dispatch.
- [ ] `STG-09` Read-only fan-out, fan-in, and routes.
  - [ ] `STG-09-G1` Join/condition/failure/budget tests pass.
  - [ ] `STG-09-G2` SQLite and query thresholds pass.
- [ ] `STG-10` Additive MCP flow API.
  - [ ] `STG-10-G1` Flow/authority/cancel/limit/pagination tests pass.
  - [ ] `STG-10-G2` Existing MCP contract tests remain byte-compatible.
- [ ] `STG-11` Prime Agent read-only shadow adapter.
  - [ ] `STG-11-G1` Identity/authority/write-denial tests pass.
  - [ ] `STG-11-G2` Session/recovery/event/accounting tests pass.
- [ ] `STG-12` Paired evaluation, cutover decision, and cleanup.
  - [ ] `STG-12-G1` Deterministic certification passes.
  - [ ] `STG-12-G2` Authorized canary passes, or is explicitly skipped.
  - [ ] `STG-12-G3` Decision threshold is evaluated without inference.
  - [ ] `STG-12-G4` Transitional fallback or rejected candidate is removed.

## Evidence records

After `STG-03`, records exist canonically in SQLite and are exported to
`IMPLEMENTATION_PROGRESS.jsonl`; the following is a human-readable projection.

```text
EVIDENCE ID:
SEQUENCE / PREVIOUS EVENT SHA256 / EVENT SHA256:
PLAN SHA256:
EFFECTIVE PLAN SHA256:
STAGE / GATE:
SOURCE FINGERPRINT:
COMMAND OR ORACLE:
INPUT HASHES:
OUTPUT HASHES:
WORKFLOW / DISPATCH / RUN / ATTEMPT:
TERMINAL RESULT:
REVIEW RECEIPTS:
ARTIFACT PATHS:
ACTOR:
RECOVERY/STATE/POLICY ESTIMATE, PREVIOUS, DELTA:
AUTONOMOUS GEEK ESTIMATE, PREVIOUS, DELTA:
RECORDED AT:
```
