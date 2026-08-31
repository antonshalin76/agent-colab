# Hybrid Agent Flow v1 R2 evidence protocol

Canonical JSON and SHA-256 rules are inherited from
`docs/hybrid-flow-v1/EVIDENCE_PROTOCOL.md`.

This revision starts a new create-if-absent `IMPLEMENTATION_START.json` and a
new pre-v4 chain under `docs/hybrid-flow-v1-r2/stage-close/pre-v4/`. Its genesis
is rooted in the new start digest. The old start and progress chain remain
immutable evidence for the superseded run and are never imported as completion
events for R2.

An R2 stage-close packet additionally records:

- required Codex auditor and critic receipt hashes;
- every optional provider state at barrier creation and closure;
- optional lane disposition: `pass`, `changes_requested`,
  `optional_unavailable`, or `reconciliation_required`;
- provider health and rejoin events;
- live launch count and known/unknown cost against the approved cap.

`PASS` requires both Codex receipts to be semantic PASS, no completed optional
CHANGES_REQUESTED finding, and no ambiguous launched attempt. The absence of an
optional provider alone is not degraded and is never converted into a synthetic
receipt.
