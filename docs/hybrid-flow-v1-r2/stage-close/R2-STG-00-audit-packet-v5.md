# R2-STG-00 architect audit packet v5

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review provider. Grok and Claude are optional helpers. Their absence, quota exhaustion, timeout, crash, or disabled state cannot stop a valid Codex-owned flow. Recovered helpers join only still-current pending work and cannot reopen a review after the required Codex barrier is satisfied.

## Closure of v4 findings

- `RunGateUnitOfWork.activateDeferred` is now the authoritative completion boundary. It rejects a satisfied barrier before provider admission and rechecks it inside its `BEGIN IMMEDIATE` activation transaction.
- If the barrier closes between the wrapper check and activation, no lane or run is created and any claimed provider admission is released.
- The public idempotent `requestReview` path cannot admit a recovered helper after Codex closure.
- Two UOW instances observing the same completed review both return `satisfied`; helper lanes remain deferred.
- MAP launch admission requires exactly one occurrence of the full trusted projection context. A duplicate or contradictory full projection fails closed, while generic marker text inside an immutable artifact remains harmless.

## RED and GREEN evidence

- RED: direct and competing activation returned `stale_artifact` or enqueued work after closure; idempotent service replay increased the durable run count; a duplicated full MAP context launched successfully.
- Focused GREEN: all three reviewer cases PASS.
- Runtime barrier file: 35/35 PASS.
- Correction integration: 5 files, 125/125 PASS.
- Full deterministic repository suite: 51 files, 1192/1192 PASS, 651.76 seconds.
- TypeScript typecheck: PASS.
- `git diff --check`: PASS.
- Production build: PASS.
- Runtime after controlled restart: systemd `active`; Codex `healthy`, Claude `healthy`, Grok `unavailable`; queue has zero queued and zero claimed rows.
- No Grok or Claude process was launched while producing or correcting v4.

## Durable review evidence

- v4 active topology was exactly Codex auditor and Codex critic; four helper lanes were deferred.
- v4 Codex auditor: `PASS`.
- v4 Codex critic: `CHANGES_REQUESTED` with the two findings closed above.
- v4 source fingerprint became stale before helper health was restored. Recovery created no helper process.
- The current source therefore requires a new exact-fingerprint Codex auditor and critic quorum.

## Authority, retry, and surface boundaries

- Required closure remains exactly Codex auditor plus Codex critic semantic PASS with exact runner evidence.
- Helper PASS cannot replace Codex. Aligned helper unavailability is non-blocking; adverse, malformed, reconciliation, and crash-window evidence remains blocking.
- Queue priorities remain coordination 0, Codex review 4, ordinary Codex workflow 10, optional review 20.
- Provider recovery remains durable-CAS admitted with exponential cooldown capped at one hour.
- No cache, Redis dependency, broker, alternate queue, second quorum calculator, or process-local health authority was added.

## Quantitative scope

- Production source delta: 10 files, 153 additions, 31 removals.
- Test delta: 11 files, 564 additions, 45 removals.
- After this gate closes, locked-plan progress is 1 of 13 implementation stages, or 7.7 percent. Frozen graph capability remains 0/12 until graph stages begin.

## Immutable plan and live budget

- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Durable R2 review launches: v1 6, v2 6, v3 7, v4 2; total R2 21. With 5 confirmed pre-R2 launches, the authorized limit is exhausted at 26/26.
- v5 must use exactly two additional launches: Codex auditor and Codex critic only. Grok and Claude are not required for closure.

## Required verdict

Inspect exact current source and tests. Return only canonical `review-verdict/v1` JSON with `PASS` or `CHANGES_REQUESTED`.

Reject any path where a helper can be admitted after authoritative completion, an activation race can enqueue after Codex closure, duplicate full MAP context is accepted, helper state blocks Codex, or malformed evidence becomes ordinary unavailability. Helper absence alone is not a finding.
