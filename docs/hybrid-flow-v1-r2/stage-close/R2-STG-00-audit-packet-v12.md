# R2-STG-00 architect audit packet v12

## Scope and invariant

This packet closes only `R2-STG-00`. It does not certify graph stages
`STG-01` through `STG-12`, cutover, or the candidate eval.

The implemented authority chain has one owner at every boundary:

`typed capture -> durable receipt -> provider health generation -> atomic activation -> prelaunch health/source/readiness fence -> spawn XOR durable no-spawn -> replay-safe barrier`

Codex auditor and critic are mandatory. Grok and Claude each retain separate
auditor and critic lanes; their absence is explicit and non-blocking. A
launched ambiguous helper attempt and any completed `CHANGES_REQUESTED` remain
blocking.

## Systemic corrections since v11

- state v4/history v2 startup is read-only and fail-closed; schema extension is
  stopped-service-only;
- recovery generations, generation consumptions, and base policies are
  immutable at the SQLite trigger boundary and checked by the schema signature;
- authority-v3 rejects caller-provided raw health/readiness/source evidence;
- asymmetric failure of either Grok/Claude role degrades the entire optional
  provider pair for that admission while Codex continues; either Codex role
  failing remains fatal;
- typed prelaunch unavailability is persisted as one terminal `no_spawn` and
  remains replay-idempotent;
- provider health is re-read inside the same `BEGIN IMMEDIATE` transaction that
  chooses spawn versus no-spawn;
- automatic recovery uses per-provider probe construction, durable generations,
  cooldown/CAS, and retries deferred rejoin after restart or transient capture
  failure without minting a second generation.

## Verification

- focused R2 authority/recovery/schema suite: `178/178 PASS`;
- final changed-seam suite: `128/128 PASS`;
- full repository suite: `65 files`, `1469/1469 PASS`, `729.71 s`;
- typecheck, production build, and `git diff --check`: `PASS`;
- mandatory Codex auditor: `PASS`;
- mandatory Codex critic: `PASS`;
- Grok auditor/critic: `DEGRADED`, local CLI timed out without a terminal
  verdict;
- Claude auditor/critic: `DEGRADED`, provider returned usage-limit 429 without
  a terminal verdict.

No Grok/Claude degraded state is converted into a synthetic PASS receipt.

## Quantitative architecture gate

The current uncommitted repository delta contains 35 production/source files
(20 tracked and 15 new) with 4,023 added and 336 removed lines, and 35 test
files (16 tracked and 19 new) with 7,102 added and 205 removed lines. This total
includes already-present, still-unclosed graph capability work; it is not
misreported as an R2-only reduction. R2 reduced duplicated authority decisions
to the owner chain above, but the broader maintained code surface grew because
new product capability is present.

R2 provider/recovery/state-policy goal: `100%` of its frozen acceptance matrix
is implemented and independently reviewed, up from the v11 checkpoint's open
startup/rejoin/ABA/prelaunch seams. Broader autonomous graph goal remains
formally `0/12` inherited stages closed; deterministic graph-core capability is
still evidence only, not stage closure.

## Publication boundary

The production service remains quarantined. This R2 PASS does not authorize
legacy linear activation or graph cutover. The next legal transition is
`STG-01` contract closure under the unchanged plan.
