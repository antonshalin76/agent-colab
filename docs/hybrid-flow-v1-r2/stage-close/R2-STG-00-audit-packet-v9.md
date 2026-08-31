# R2-STG-00 architect audit packet v9

## Contract

Codex is the required coordinator, executor, recovery owner, and minimum review
provider. Grok and Claude are optional diversity harnesses. Their absence,
quota, timeout, crash, disabled state, authentication failure, or missing skill
root cannot block an otherwise valid Codex-owned flow. Rejoin is permitted only
for current pending work after affirmative skill readiness, provider admission,
and source-fingerprint checks.

## Systemic recovery scope

v8 did not close the stage. Its Codex critic returned three blocking findings,
and its Codex auditor exited without a verdict after read-only Vitest cache
attempts. The source was changed before optional helper health was restored, so
v8 is stale and no helper was admitted against it.

The three critic findings were treated as one broken evidence chain rather than
three local patches. The binding design is recorded in
`R2-STG-00-systemic-recovery.md`:

- terminal evidence is resolved once before typed or textual failover evidence;
- `recordProviderUnavailable` validates the exact launched run and atomically
  persists the accepted provider result and terminal time in the existing lane
  projection;
- every barrier evaluation recomputes run identity and compares the mutable run
  envelope with that independent accepted projection;
- a new attempt atomically clears the prior lane projection, while source-stale
  transitions retain the last accepted provider outcome;
- `RunGateUnitOfWork.activateDeferred` itself requires
  `harnessReady === true` before health admission or state mutation. Service and
  worker callers pass current per-harness skill readiness.

No new queue, cache, scheduler, quorum calculator, process-local health owner,
database table, or schema migration was added.

## Complete RED and GREEN evidence

- Comprehensive RED against restored pre-v8 production behavior: 21 failure
  manifestations across seven typed terminal collisions, eleven
  post-acceptance run mutations, two authoritative-admission readiness cases,
  and one wrapper missing-readiness case.
- Focused systemic GREEN: 3 files, 119/119 PASS.
- Integration GREEN across classifier, runner, review UOW, rejoin, provider
  health, app service, MCP, provider version, and verdict parsing: 7 files,
  167/167 PASS.
- Full deterministic repository gate: 51 files, 1232/1232 PASS in 674.99
  seconds.
- TypeScript typecheck, production build, `git diff --check`, and structural
  caller scan: PASS. The only calls without an explicit readiness field are the
  deliberate runtime-missing negative controls.

## Mutation matrix

After exact helper-unavailability acceptance and Codex quorum completion, each
of these independent mutations makes the barrier false; restoring the exact row
makes it true again:

1. canonical run payload;
2. launch session identity;
3. effect review ID;
4. effect attempt ID;
5. effect role;
6. effect agent;
7. effect result kind;
8. effect terminal time;
9. provider result;
10. domain-effect lifecycle state;
11. run terminal status.

## Ownership and fail-closed behavior

| Decision | Sole owner | Failure behavior |
|---|---|---|
| terminal versus failover | shared outcome classifier | terminal wins |
| accepted helper outage | review UOW exact evidence predicate plus lane projection | mismatch blocks |
| review closure | `RunGateUnitOfWork.barrier` | non-exact or adverse evidence blocks |
| recovered lane admission | `RunGateUnitOfWork.activateDeferred` | missing readiness, health, or source proof blocks |
| provider cooldown and lease | `ProviderHealthStore` | no runnable admission |

Codex task failure, invalid request, safety or permission denial, user
cancellation, malformed output, unsupported model, ambiguous launch, and
`needs_reconciliation` remain blocking. Optional provider unavailability is
non-blocking only while all exact durable evidence remains aligned.

## Quantitative scope

- Production source: 11 files, 345 additions, 72 removals.
- Tests: 11 files, 948 additions, 54 removals.
- Total source and tests: 22 files, 1293 additions, 126 removals.
- Locked-plan progress remains 0 of 13 closed stages until this audit passes;
  frozen graph capability remains 0/12.
- Plan lock SHA-256:
  `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest:
  `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Live review launches are exhausted at 34/34. A v9 quorum requires separate
  authorization for exactly two more read-only Codex launches; the USD cap
  remains unchanged.

## Required verdict

Inspect the exact source, tests, systemic recovery document, and this immutable
packet. Return only canonical `review-verdict/v1` JSON with `PASS` or
`CHANGES_REQUESTED`.

Reject terminal-to-failover laundering, acceptance and closure derived from the
same mutable run envelope, missing or optional readiness at authoritative
admission, stale projection reuse, transient closure, late reopening, helper
substitution for Codex, or contradictory complete MAP projections.
