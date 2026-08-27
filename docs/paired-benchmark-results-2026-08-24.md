# Paired benchmark diagnostics: 2026-08-24

## Verdict

No run from 2026-08-24 is accepted as measurement evidence. The live batches
were started before the harness, both provider capability surfaces, and the
canary path had passed explicit certification gates. Their numbers must not be
used to assign roles, tune effort routing, or claim that either agent is better.

The retained runs are diagnostic negative controls. They identified defects
that a deterministic certification stage should have caught before any batch
of provider requests.

## Defects exposed

- Skill manifests used different sort orders and produced false parity drift.
- An in-workspace `.git` policy violation crashed the runner instead of becoming
  a terminal classified outcome.
- A 512 KiB file-size limit broke C++ compilation.
- The Translator oracle lacked its required Pydantic and Pytest runtime.
- An 8 GiB address-space limit was incompatible with ASan shadow memory.
- Grok CLI 1.0.5 returned the final schema payload in `structuredOutput`; the
  old parser joined progress text and misclassified valid output.

These failures are now represented in deterministic tests or local runtime
smokes. That fact becomes trusted only when `certify-harness` issues a passed
receipt against the exact current implementation and environment.

## Non-evidentiary observations

The last diagnostic batch contained eight pairs and sixteen attempts on
`PUNTO-BUG-03` and `TR-BUG-01` at `medium`. Its quality, time, token, and cost
figures are intentionally not repeated as benchmark results because the launch
preconditions were invalid. Raw terminal artifacts remain outside the source
repository for failure analysis and are excluded from routing decisions.

A later one-file Grok probe demonstrated one mutating tool path after the parser
fix. It did not certify search, local tests, shared-skill discovery, Codex
parity, hidden-oracle execution, or paired persistence, so it is not a provider
capability receipt.

## Required sequence

1. Pass deterministic harness certification with zero provider requests.
2. Pass one bounded capability probe per provider against the same frozen
   skills and functional tool contract.
3. Pass one paired canary cell with both terminal attempts, sealed blind
   mapping, source immutability, and both hidden oracle executions.
4. Add executable hidden oracles for all six remaining corpus cases.
5. Only then run the predeclared full measurement matrix.

Until all five conditions hold, the existing `routing-v3` allocation remains a
provisional hypothesis rather than an empirically optimized role assignment.

## Staged certification attempt

The controlled v6 attempt stopped at the one-cell canary and did not launch the
measurement matrix:

| Stage | Requests | Result |
|---|---:|---|
| deterministic harness | 0 | 13/13 checks passed on the then-current implementation |
| provider capability | 2 | 10/10 artifact checks passed, later rejected by audit as insufficient evidence |
| paired canary | 2 | failed: 6/7 checks passed; neither arm reached a successful hidden-oracle result |
| full measurement | 0 | not launched |

The canary found a Codex diff-budget failure (1,043,430 bytes across 224 files,
mostly generated build output) and a Grok task failure. Source receipts and
blind pairing remained intact. These are infrastructure diagnostics, not model
quality measurements.

Independent review returned `CHANGES_REQUESTED`. It found that provider network
access was shared with the candidate namespace, tool and test activity was not
bound to retained evidence, receipt status was trusted instead of derived, and
run-root checks were vulnerable to symbolic-link traversal. Both bounded Grok
review modes also failed to emit a parseable verdict, so the required dual-agent
review barrier is degraded.

The deterministic follow-up now derives receipt status, requires two successful
canary arms with two hidden-oracle results, rejects symbolic links in run roots
and nested stage directories, and binds provider capability claims to sanitized
native tool activity, randomized task inputs, a nonce-bearing test receipt, and
a localhost network-denial sentinel. Those changes invalidate the earlier v6
hashes.

The v6 `cpp/build/**` confound is fixed deterministically: the sealed baseline
still force-indexes every source file, while the post-attempt tree follows Git
ignore rules for newly generated files. A regression test writes 128,000 bytes
under ignored `build/` while changing a tracked source file; only the tracked
change appears in the scored diff.

## Rejected v10 chain

The v10 chain advanced one stage further but still stopped before measurement:

| Stage | Requests | Result |
|---|---:|---|
| deterministic harness | 0 | passed 13/13 |
| provider capability | 2 | passed 11/11 for Codex and Grok |
| paired canary | 2 | failed 6/7 because only one arm reached its hidden oracle |
| full measurement | 0 | not launched |

Harness receipt:
`6de3750f38321759341f99091301345d31586b0d8bef36895927e1255653ca31`.
Provider receipt:
`a86f0e2d0d314b2ac0cb1befd953235f2384e06884ab111d9abca46432557763`.
Failed canary receipt:
`b51dbffbb51268a7e882a55eec46a4936127cf8b0a4ece0a6256350dbb33aba5`.

Both provider probes satisfied the implemented checks for the pinned model and
`medium` effort, read, search, edit, local test, common frozen skill, protocol
telemetry, cleanup, source immutability, and denial of the localhost sentinel.
The follow-up audit rejected these checks as certification evidence because the
candidate could imitate the marker and tool booleans without executing the
script, raw Grok logs remained in disposable state, launches lacked a durable
pre-call disposition, and canary source receipts covered only its selected
repository.

In the canary, Codex completed in 345,476 ms, changed two tracked files, and
passed the hidden oracle at 100/100. Grok terminated as `task_failure` in
363,861 ms after changing three tracked files, so its hidden oracle correctly
did not run. Both arms were persisted terminally; parity, blind mapping, source
immutability, and absence of harness/provider invalidation passed. Strict
two-oracle gating failed, as intended.

The code now blocks provider certification before live calls, which invalidates
the v10 binding and its downstream canary receipt. This single canary remains
diagnostic infrastructure evidence, not comparative role evidence.
The full matrix remains blocked by the failed canary, six missing executable
oracles, and the uncertified full-run persistence path. No routing was changed.

## Current v11 state

The current harness-only receipt passed 13/13 checks with zero model requests:
`bda572ff7b27d481672388002c446dec6b6b871e855866630cbfb12c7b5fa5f9`.
It explicitly reports `launchAllowedForProviderCertification: false` with the
four audit blockers above. No v11 provider, canary, or measurement request was
launched.
