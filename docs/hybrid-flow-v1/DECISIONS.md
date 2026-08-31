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
