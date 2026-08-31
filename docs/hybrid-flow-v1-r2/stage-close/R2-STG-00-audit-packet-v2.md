# R2-STG-00 architect audit packet v2

## Required behavior

Codex is the required coordinator and minimum review provider. Grok and Claude are optional. Their absence, quota failure, timeout, crash, or disabled state cannot stop valid Codex work. Recovered helpers join still-current pending work automatically.

## V1 review findings and resolutions

The v1 Codex auditor and critic returned `CHANGES_REQUESTED`.

1. Malformed successful helper output was normalized to ordinary `task_failure`. The runner now persists `reviewOutputInvalid: true`; the barrier treats this as blocking integrity evidence.
2. A committed terminal run could precede lane-effect replay. The barrier now checks every optional attempt/lane state pair. `run=completed` with `lane=queued/deferred` blocks until replay.
3. Fingerprint capture could throw out of the recovery loop. `review-rejoin.ts` isolates unreadable optional projects and continues with other reviews; storage and CAS errors still propagate.
4. Policy flags were projected but partially reimplemented. The barrier now consumes `REVIEW_BARRIER_POLICY` for required agent, required count, optional unavailability, adverse completion, and reconciliation.
5. A derived scheduling risk gave helpers the same priority as Codex. Required Codex review runs now use priority 4; optional runs use priority 5.
6. The full suite exposed HOME-dependent Grok version text. `discoverProviderVersion()` removes only the ` [stable]` channel suffix so host and contained probes compare the binary version consistently.

## Current safety properties

- Closure needs exact canonical PASS receipts from Codex auditor and critic.
- Helper PASS cannot substitute for Codex.
- Completed helper `CHANGES_REQUESTED`, malformed output, durable mismatch, and `needs_reconciliation` block.
- Ordinary aligned helper failure, timeout, quota failure, or disabled state does not block.
- Rejoin uses durable health admission, cooldown, attempt lease, current source fingerprint, CAS transition, and deterministic idempotency keys.
- An unreadable optional project cannot stop recovery for other projects.
- Codex review work is claimed before optional review work when workers are free.

## Verification

- Quorum and attempt-state suite: 32/32 PASS before the priority correction; focused correction set: 6/6 PASS after all fixes.
- Review/service/MCP integration suite: 62/62 PASS before reviewer corrections.
- Provider containment regression that failed in the full suite: PASS after version normalization.
- TypeScript typecheck: PASS after all corrections.
- Full pre-correction suite: 1178/1179 PASS; the sole failure was the now-fixed Grok version identity test.
- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Confirmed live launches before this v2 audit: 11 of 24; cost remains unknown under the USD 10 cap.

## Review contract

Return canonical `review-verdict/v1` with `PASS` or `CHANGES_REQUESTED`.

Check the current source and tests, not the superseded v1 packet alone. A helper's unavailability is not a finding. Any path that hides adverse completed evidence, lets helpers delay Codex, causes a retry storm, stops the worker from optional project state, duplicates policy ownership, or weakens source/authority/reconciliation must return `CHANGES_REQUESTED`.
