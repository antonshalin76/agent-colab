# R2-STG-00 architect audit packet v8

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review provider. Grok and Claude are optional diversity harnesses. Missing binaries, skill roots, authentication, quota, timeout, crash, disabled state, or provider outage cannot block a valid Codex-owned flow. Optional harnesses rejoin automatically only when provider health, shared-skill readiness, source fingerprint, and pending barrier state all permit it.

## Closure of v7 findings

- Canonical `task_failure`, `invalid_request`, `safety_denial`, `permission_denial`, and `user_cancelled` tokens are matched before every failover rule. Unsupported-model and model-not-found evidence also precede rate-limit and quota markers.
- `recordProviderUnavailable` now requires one exact immutable runner context: launched run identity, priority, artifact, approval scope, complete payload, review/attempt/role/agent identity, provider result kind, admission claim, terminal time, and durable effect envelope.
- Seven negative mutations cover review ID, attempt ID, role, agent, result kind, terminal time, and canonical payload. Only the already-protected terminal-time mutation passed before the correction; the other six failed RED.
- Shared-skill readiness is evaluated per harness. Codex readiness remains mandatory. Missing or divergent Grok/Claude roots downgrade only those optional lanes and cannot fail Codex delegation or review.
- Provider health and skill readiness remain separate. The service applies both during initial admission; the worker re-evaluates skill readiness before automatic rejoin, so a missing helper root cannot launch and a restored root becomes eligible again under the existing provider cooldown.

## RED and GREEN evidence

- RED: 13 targeted failures across canonical-token collisions, exact effect/payload identity, and Codex-only skill installation.
- Focused correction: 4 files, 134/134 PASS.
- Correction integration: 7 files, 161/161 PASS.
- Full deterministic repository suite: 51 files, 1222/1222 PASS, 392.53 seconds.
- One unrelated cross-process MAP `-journal` TOCTOU occurred in an earlier full run; MAP-003B passed isolated in 12.33 seconds and passed in the clean full rerun. No MAP production file was changed.
- TypeScript typecheck, `git diff --check`, and production build: PASS.

## Durable review evidence

- v7 topology was exactly Codex auditor and critic active; four helper lanes were deferred.
- Both v7 Codex roles returned `CHANGES_REQUESTED`. Their four findings are closed above.
- The source fingerprint changed before helper health restoration, making v7 stale. No optional helper launched against the stale artifact.
- Current source requires a new exact-fingerprint Codex auditor and critic quorum.

## Outcome and admission matrix

| Evidence or harness state | Closure/admission |
|---|---|
| canonical terminal token mixed with failover evidence | blocking terminal outcome |
| unsupported/model-not-found mixed with quota or rate limit | blocking task failure |
| exact failover run, payload, effect, lane, result, and time | non-blocking `provider_unavailable` |
| any failover identity or payload mismatch | blocking |
| required Codex skill root missing/divergent | fail closed before launch |
| optional helper skill root missing/divergent | helper unavailable; Codex continues |
| optional root restored and provider eligible on current pending work | automatic bounded rejoin |
| satisfied or source-stale review | no rejoin |

## Quantitative scope and budget

- Production source delta: 11 files, 311 additions, 66 removals.
- Test delta: 11 files, 815 additions, 50 removals.
- Total source-and-test delta: 22 files, 1126 additions, 116 removals.
- Locked-plan progress remains 0 of 13 closed stages until this audit passes; frozen graph capability remains 0/12.
- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Durable R2 review launches: v1 6, v2 6, v3 7, v4 2, v5 2, v6 2, v7 2; total R2 27. With 5 confirmed pre-R2 launches, the authorized limit is exhausted at 32/32.
- v8 requires separate authorization for exactly two further launches: Codex auditor and Codex critic only. The USD cap remains unchanged.

## Required verdict

Inspect the exact current source, tests, and this immutable packet. Return only canonical `review-verdict/v1` JSON with `PASS` or `CHANGES_REQUESTED`.

Reject terminal-to-failover laundering, result-only timeout validation, optional skill-root coupling that blocks Codex, rejoin without skill readiness, transient closure, late reopening, helper substitution for Codex, or contradictory complete MAP projections.
