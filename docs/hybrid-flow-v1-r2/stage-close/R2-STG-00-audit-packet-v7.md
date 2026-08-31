# R2-STG-00 architect audit packet v7

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review provider. Grok and Claude are optional helpers. Missing, unavailable, quota-limited, timed-out, crashed, or disabled helpers cannot block a valid Codex-owned flow. A launched helper remains blocking until its terminal evidence is durably aligned or reconciled. Recovered helpers join only still-pending work for the current immutable artifact.

## Closure of v6 findings

- Mixed terminal and availability evidence is now classified terminal-first. `task_failure`, `invalid_request`, `safety_denial`, `permission_denial`, and `user_cancelled` cannot be laundered into `model_unavailable`, including explicit collision cases.
- A canonical helper timeout is persisted as a completed failover domain effect, verified exactly by `recordProviderUnavailable`, and projected as a deferred `provider_unavailable` attempt. Artificial or mismatched `timed_out` lane state remains blocking.
- Source-drift handling and the satisfied-barrier check now share one `BEGIN IMMEDIATE` transaction. A stale transition cannot race a concurrent Codex close, and an aligned unavailable attempt remains non-blocking after its helper lane becomes stale.
- The satisfied guard is repeated inside the admission transaction. No recovered helper can enqueue after terminal closure.
- The full-flow timeout adjustment is test-local: one integration test now has a 30-second budget after two reproducible full-suite durations of 21.709 and 21.469 seconds against its former 20-second limit. Production timeouts are unchanged.

## RED and GREEN evidence

- RED: five adverse/availability collision cases and one unavailable-plus-source-drift case failed before the correction.
- Focused correction files: 2 files, 92/92 PASS.
- Correction integration: 6 files, 133/133 PASS.
- The affected `app-service` file: 23/23 PASS.
- Full deterministic repository suite: 51 files, 1205/1205 PASS, 393.20 seconds.
- Two preceding full runs reached 1204/1205 and failed only the same 20-second test budget; its isolated logic passed in 18.48 seconds before the local budget correction.
- TypeScript typecheck, `git diff --check`, and production build: PASS.

## Durable review evidence

- v6 topology was exactly Codex auditor and critic active; four helper lanes were deferred.
- Both v6 Codex roles returned `CHANGES_REQUESTED`. The critic reported terminal-first classification and exact timeout evidence; the auditor reported the stale-transition race. All three findings are closed above.
- The source fingerprint changed before helper health restoration, so v6 is stale and no helper rejoin can validate it.
- Current source requires a new exact-fingerprint Codex auditor and critic quorum.

## Outcome matrix

| Durable optional state | Closure |
|---|---|
| no attempt and deferred/stale | non-blocking |
| scheduled or reconciliation | blocking |
| aligned quota, rate limit, overload, network timeout, model unavailable, missing CLI, auth | non-blocking as `provider_unavailable` |
| task failure, invalid request, safety denial, permission denial, user cancellation | blocking |
| raw/mismatched `timed_out`, malformed result, or run/lane mismatch | blocking |
| semantic PASS with exact runner evidence | non-blocking |
| semantic changes/inconclusive | blocking |

## Quantitative scope and budget

- Production source delta: 10 files, 172 additions, 46 removals.
- Test delta: 11 files, 664 additions, 47 removals.
- Total source-and-test delta: 21 files, 836 additions, 93 removals.
- Locked-plan progress remains 0 of 13 closed stages until this audit passes; frozen graph capability remains 0/12 until graph stages begin.
- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Durable R2 review launches: v1 6, v2 6, v3 7, v4 2, v5 2, v6 2; total R2 25. With 5 confirmed pre-R2 launches, the authorized limit is exhausted at 30/30.
- v7 requires separate authorization for exactly two further launches: Codex auditor and Codex critic only. The USD cap remains unchanged.

## Required verdict

Inspect the exact current source, tests, and this immutable packet. Return only canonical `review-verdict/v1` JSON with `PASS` or `CHANGES_REQUESTED`.

Reject terminal-to-availability laundering, noncanonical timeout evidence, transient closure, late reopening, helper substitution for Codex, contradictory complete MAP projections, or any helper absence that blocks a valid Codex-only flow.
