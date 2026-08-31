# R2-STG-00 architect audit packet v6

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review provider. Grok and Claude are optional helpers. A helper that is unavailable at admission is deferred and cannot block Codex. A helper already admitted participates only until a bounded terminal state; closure cannot pass transiently and later reopen.

## Closure of v5 findings

- A scheduled optional attempt now blocks closure. Required Codex PASS can close only after every admitted helper lane reaches a durable terminal state.
- Explicit helper timeout and provider-unavailability outcomes remain non-blocking after terminal alignment. No indefinite or ambiguous in-flight state is treated as absence.
- Optional `task_failure`, `invalid_request`, `safety_denial`, `permission_denial`, and `user_cancelled` always block.
- Malformed or incomplete provider streams/results now classify as `task_failure` at the shared outcome owner, not `model_unavailable`.
- MAP admission requires one exact trusted context and exactly one complete projection header across Codex, Grok, and Claude. A second block with another digest, consumer, or payload fails closed; partial generic marker text remains harmless.
- The authoritative atomic satisfied guard from v4 remains in `activateDeferred`; after terminal closure, rejoin cannot create another helper lane.

## RED and GREEN evidence

- RED: one scheduled helper allowed transient closure; five adverse outcome classes were non-blocking; two malformed transport cases were retryable; a contradictory full MAP block launched.
- Focused reviewer cases: 9/9 PASS.
- Provider/barrier files: 86/86 PASS.
- Correction integration: 6 files, 145/145 PASS.
- Full deterministic repository suite: 51 files, 1199/1199 PASS, 658.19 seconds.
- TypeScript typecheck, `git diff --check`, production build: PASS.
- Runtime after restart: systemd `active`; Codex and Claude `healthy`, Grok `unavailable`; queue has zero queued and zero claimed rows.

## Durable review evidence

- v5 active topology was exactly Codex auditor and critic; four helper lanes were deferred.
- Both v5 Codex roles returned `CHANGES_REQUESTED`; their findings are closed above.
- v5 became source-stale before helper health restoration, and no helper run launched.
- Current source therefore requires a new exact-fingerprint Codex auditor and critic quorum.

## Outcome matrix

| Durable optional state | Closure |
|---|---|
| no attempt and deferred/stale | non-blocking |
| scheduled or reconciliation | blocking |
| quota, rate limit, overload, network timeout, model unavailable, missing CLI, auth | non-blocking after aligned terminal persistence |
| task failure, invalid request, safety denial, permission denial, user cancellation | blocking |
| malformed result or run/lane mismatch | blocking |
| semantic PASS with exact runner evidence | non-blocking |
| semantic changes/inconclusive | blocking |

## Quantitative scope and budget

- Production source delta: 10 files, 160 additions, 32 removals.
- Test delta: 11 files, 609 additions, 46 removals.
- Locked-plan progress after closure: 1 of 13 stages, or 7.7 percent; frozen graph capability remains 0/12 until graph stages begin.
- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Durable R2 review launches: v1 6, v2 6, v3 7, v4 2, v5 2; total R2 23. With 5 confirmed pre-R2 launches, the authorized limit is exhausted at 28/28.
- v6 requires exactly two further launches: Codex auditor and Codex critic only.

## Required verdict

Inspect exact current source and tests. Return only canonical `review-verdict/v1` JSON with `PASS` or `CHANGES_REQUESTED`.

Reject transient closure, late reopening, ambiguous failure-to-availability conversion, contradictory complete MAP projections, helper substitution for Codex, or any helper absence that blocks a valid Codex-only flow.
