# Hybrid Agent Flow v1 — decision ledger

This file is append-only after implementation start. It may clarify an
implementation detail inside the locked contracts but cannot change objective,
scope, ownership, dependencies, gates, acceptance, or authority.

## Stabilization decisions

- `DEC-001`: The graph scheduler is an orchestration layer above existing
  bounded workflows; `RunStore` remains a ready-work execution queue.
- `DEC-002`: Version 1 conditions use only terminal outcome or a declared typed
  result route.
- `DEC-003`: Concurrent fan-out is read-only. Mutable work remains serialized
  by the Codex-only worktree lease.
- `DEC-004`: Session memory is a structured bounded checkpoint without semantic
  retrieval or a vector database.
- `DEC-005`: Prime Agent is an optional read-only adapter and cannot own routing,
  authority, workflow state, or review topology.
- `DEC-006`: Result acceptance and node admission are separate durable units of
  work joined by an idempotent admission intent.
- `DEC-007`: Later mutable nodes wait for authority bound to their exact ready
  revision and admission hash; approval is not retained speculatively.
- `DEC-008`: Prime is a shadow subprocess backend selected by an immutable
  broker adapter policy after routing-v5, never a routing identity.
- `DEC-009`: Markdown progress is a generated view of a hash-chained JSONL
  ledger; the pre-start lock manifest has no mutable status booleans.
- `DEC-010`: Durable telemetry events use one-based per-flow sequences and hash
  the exact `AgentEventEnvelope` header. Every live body is the canonical
  `TelemetryPayload/v1` wrapper; its `parentSessionId` must match both the event
  header and immutable session ancestry.
- `DEC-011`: Provider adapters expose sanitized raw usage facts. One telemetry
  normalizer accepts only provider-reported safe-integer tokens, converts USD to
  micro-USD only when lossless, and maps the six provider fields onto the three
  canonical accounting columns. Subtree selection follows `CONTRACTS.md`:
  candidates are owned by attempts without self receipts, ordered by descending
  logical coverage then usage ID, and replace covered descendant self receipts.
- `DEC-012`: Telemetry archives use bounded canonical JSONL segments with an
  exact header and contiguous ordered members. Merkle leaves are
  `SHA256(0x00 || canonical-member)`; parents are
  `SHA256(0x01 || left32 || right32)` with an odd digest duplicated. The archive
  file is fsynced before the manifest/anchor transaction, then reverified before
  the separate idempotent payload-deletion transaction.
- `DEC-013`: Post-v4 progress is SQLite-authoritative. One store owns progress
  sequence, amendment consumption, outbox snapshots, and watermark marking;
  filesystem projections are serialized through a dedicated projection lock and
  never grant plan authority.
- `DEC-014`: Durable telemetry strings use field-specific byte contracts.
  Flow, event, node, attempt, session, parent-session, usage, receipt, and archive
  request IDs are ASCII `[A-Za-z0-9._:-]`, 1..128 UTF-8 bytes. Providers are
  `codex | grok | claude`; provider-session references allow printable Unicode up
  to 256 UTF-8 bytes but reject sensitive values, C0/C1 controls, CR/LF, and bidi
  controls. Session kind is `node_attempt | coordination`; event type is lowercase
  snake case up to 64 bytes; event version is `[A-Za-z0-9._-]`, 1..32 bytes.
  Trace and span IDs are nonzero lowercase hexadecimal strings of 32 and 16 bytes.
