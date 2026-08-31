# R2-STG-00 architect audit packet v4

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review provider. Grok and Claude are optional helpers. Their absence, quota exhaustion, timeout, crash, or disabled state cannot stop a valid Codex-owned flow. A recovered helper joins only still-current pending work; it cannot reopen a review whose required Codex barrier is already satisfied.

## Changes since v3

- Codex transport now selects the last completed assistant message as the terminal response. A separate policy-required skill announcement no longer corrupts a strict JSON verdict.
- The canonical `review-verdict/v1` parser remains strict. Markdown, surrounding text in the terminal message, multiple objects, unknown fields, and semantic contradictions still fail closed as `reviewOutputInvalid`.
- Optional rejoin checks the authoritative barrier before fingerprint capture or activation CAS. A satisfied Codex barrier is skipped and reported as `skippedSatisfied`.
- No queue, cache, broker, Redis dependency, alternate quorum calculator, or process-local availability authority was added.

## Prior independent evidence

- v3 Claude auditor: `PASS` with informational findings only.
- v3 Claude critic: `PASS` with informational findings only.
- v3 Codex auditor and critic reached the provider but were rejected as malformed because their required skill announcements preceded canonical JSON. The durable lanes remained failed and the barrier remained closed. No success was laundered.
- Grok was unavailable/deferred and did not block Codex-owned work.

## Test and runtime evidence

- Terminal-message RED: normalization returned `announcement + verdict`, and the strict parser failed.
- Terminal-message GREEN plus verdict and provider normalization: 3 files, 100/100 PASS.
- Completed-review rejoin RED: recovery invoked activation after a satisfied Codex barrier.
- Completed-review rejoin GREEN with barrier and runner integration: 3 files, 80/80 PASS.
- Full deterministic repository suite: 51 files, 1190/1190 PASS, 649.31 seconds.
- TypeScript typecheck: PASS.
- `git diff --check`: PASS.
- Production build: PASS.
- Runtime after controlled restart: systemd `active`; Codex `healthy`, Claude `healthy`, Grok `unavailable`; queue has zero queued and zero claimed rows.

## Authority and retry boundaries

- Required closure remains exactly Codex auditor plus Codex critic semantic PASS with exact durable runner evidence.
- Helper PASS cannot replace Codex. Aligned helper unavailability is non-blocking. Helper adverse or malformed completion, reconciliation ambiguity, and attempt/lane mismatch remain blocking.
- Codex review priority is 4, ordinary Codex workflow priority is 10, and optional review priority is 20.
- Provider recovery uses durable admission CAS and a one-hour-capped exponential cooldown.
- Rejoin skips unreadable projects without swallowing persistence/CAS faults, rejects source drift, and now skips satisfied barriers.
- Approval, MAP binding, source fingerprint, idempotency, launch fences, and effect replay remain authoritative and durable.

## Quantitative scope

- Production source delta: 10 files, 143 additions, 30 removals.
- Test delta: 11 files, 463 additions, 38 removals.
- Locked implementation progress after this gate can close: R2-STG-00 is 1 of 13 planned implementation stages, or 7.7 percent. Frozen eval capability remains 0/12 until the graph stages begin; this stage certifies the provider-availability invariant, not graph capability.

## Immutable plan and live budget

- Plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Durable database evidence: v1 used 6 launched runs, v2 used 6, and v3 used 7; R2 total is 19. Together with 5 confirmed pre-R2 launches, the approved limit is exhausted at 24/24.
- No v4 provider process may launch without a separate two-launch extension. The intended v4 topology is Codex auditor and Codex critic only; Grok and Claude are not required for closure.

## Required verdict

Inspect the exact current source and tests. Return only canonical `review-verdict/v1` with `PASS` or `CHANGES_REQUESTED`.

Reject any path where helper state delays Codex, malformed output becomes availability, completed work is reopened by helper recovery, retries can storm, terminal Codex output is composed from progress messages, or policy is recomputed outside its owner. Helper absence alone is not a finding.
