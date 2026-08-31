# R2-STG-00 architect audit packet v3

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review provider. Grok and Claude are optional. Their absence, quota exhaustion, timeout, crash, or disabled state cannot stop a valid Codex-owned flow. Recovered helpers join still-current pending work automatically under durable admission.

## Closure of v1 and v2 findings

- Required closure uses exact Codex auditor and critic semantic PASS receipts.
- Optional adverse completion, malformed output, attempt/lane mismatch, and `needs_reconciliation` block closure.
- Optional aligned failure and timeout do not block.
- `reviewOutputInvalid` distinguishes malformed successful output from harness unavailability.
- A terminal run whose lane effect has not replayed blocks during the crash window.
- Rejoin skips an unreadable optional project without swallowing storage/CAS faults.
- `REVIEW_BARRIER_POLICY` owns required and optional closure policy; MCP only projects it.
- Codex review priority is 4, ordinary Codex workflow priority is 10, optional review priority is 20.
- Grok `402 Payment Required` and `balance exhausted` classify as `quota`.
- Repeated failover cooldown grows exponentially and is capped at one hour; a durable CAS permits one probe after each cooldown.
- Expected and observed provider versions share `normalizeProviderVersion`; the HOME-dependent ` [stable]` suffix cannot create false `version_mismatch`.
- MAP validation requires the exact current projection context but does not count marker text inside an untrusted immutable artifact.
- A durable failed `network_timeout` maps to `timed_out`; an aligned optional timeout is non-blocking.
- Rejoin source binding, idempotency keys, launch fences, approval policy, MAP admission, and reconciliation remain unchanged.

## Test evidence

- Reviewer-correction focused RED cases failed for their intended reasons before implementation.
- Correction integration: 8 files, 167/167 PASS.
- Full deterministic repository suite: 51 files, 1188/1188 PASS, 650.49 seconds.
- TypeScript typecheck: PASS.
- `git diff --check`: PASS.
- Built runtime status after safe restart: systemd `active (running)`; providers Grok `probing`, Claude `healthy`, Codex `healthy`; queue has no queued or claimed rows.
- Review status projection reports Codex auditor/critic required and four helper lanes optional.

## Immutable plan and budget

- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Confirmed launches before v3: 17 of 24. Cost is unknown and remains bounded by the approved USD 10 cap.

## Required verdict

Inspect current source and tests. Return canonical `review-verdict/v1` with `PASS` or `CHANGES_REQUESTED`.

Reject any path where optional state delays or stops Codex, adverse evidence becomes ordinary unavailability, retries can storm, untrusted artifact text breaks launch admission, version normalization differs across comparison sides, or policy is recomputed outside its owner. Optional provider absence alone is not a finding.
