# STG-00 BDD and SRP evidence

## Scenarios

- `S00-01`: Given the locked package and valid start receipt, when verification runs, then it returns `verified` and the exact start hash.
- `S00-02`: Given a modified start field or digest, when verification runs, then it fails closed.
- `S00-03`: Given a modified normative artifact, when verification runs, then it fails closed.
- `S00-04`: Given an anchor whose tree or parent does not bind the locked inventory and source baseline, when verification runs, then it fails closed.
- `S00-05`: Given a second byte-identical start receipt, when create-if-absent is replayed, then the existing receipt is accepted; different bytes conflict.

## Traceability

| Scenario | Acceptance/gate | Owner | Test seam |
|---|---|---|---|
| S00-01 | STG-00 valid start | progress verifier | process exit and JSON result |
| S00-02 | blocked_plan_integrity | progress verifier | tampered isolated fixture |
| S00-03 | immutable package | progress verifier | artifact digest mismatch |
| S00-04 | Git/source binding | progress verifier | Git object inspection |
| S00-05 | create-if-absent replay | start receipt writer | byte comparison helper |

BDD critic (self-review): `PASS`. Negative, replay, source, and package-integrity paths prevent a presence-only false green.

BDD auditor (self-review): `PASS`. Every STG-00 integrity gate has an observable deterministic test.

## Responsibility ownership

| Slice | Authoritative owner | Reason to change |
|---|---|---|
| integrity decisions | `verify-implementation-progress.mjs` | evidence protocol changes |
| persistence | filesystem create-if-absent receipt writer | receipt storage mechanism changes |
| state transitions | verifier result only; no workflow mutation | integrity state-machine changes |
| audit evidence | verifier JSON output | evidence projection changes |
| UI state | N/A | no UI |
| broker/proxy decisions | N/A | verifier never routes or dispatches |

Pre-RED SRP self-audit: `PASS`. Tests observe the CLI seam; neither tests nor projections duplicate integrity policy.
