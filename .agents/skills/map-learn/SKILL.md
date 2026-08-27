---
name: map-learn
description: Close reviewed agent-collab findings into provider-neutral MAP learning records for Codex and Grok after exact profile and provenance verification.
---

# MAP Learn

Use this local adapter only after review findings are resolved against one immutable task packet. It complements MAP 3.28.1 because the upstream Codex profile does not provide `map-learn`.

## Contract

- Keep this skill outside `.map/mapify.lock.json`. MAP upgrades must not claim or overwrite it.
- Verify the installation with `verifyInstalledMapProfile` from `src/flow/map-admin.ts`. Stop on profile, manifest, version, provider, hook, inventory, or raw-byte drift.
- Preserve the original task packet and learning handoff bytes. Do not parse and reserialize either artifact before closing it.
- Encode the candidate as canonical JSON followed by one newline. Its `consumerScopes` must be `codex` and `grok`; control IDs must be sorted.
- Close only through `agent-collab map-learn-close <task-packet> <handoff> <candidate>`. The configured service pins the control root and authoritative `collaboration.db`; callers cannot select a project root, evidence database, or structural authority. The command derives task, manifest, handoff, and candidate digests from the supplied bytes and the checked-in MAP profile lock.
- Before assembling the task packet, call `agent-collab map-evidence-record <finding-lifecycle.json> <purpose> <evidence-id> <candidate-sha256>` once for each exact purpose: `code_or_artifact_fix`, `old_code_sensitive_regression`, and `sibling_surface_scan`. The service derives stage, oracle, affected control, typed root-cause class, and mutation identity from the canonical registry; callers cannot supply a command, result, timestamp, stage, oracle, control, or source fingerprint.
- Require the canonical task packet to contain the exact candidate, validated finding lifecycles, and process-backed closure evidence. Close only oracle/control defect classes whose typed root-cause class and regression mutation match the code-owned registry; keep every unsupported or mismatched class open. Each evidence receipt must resolve through its immutable canonical execution row and current target/control-plane fingerprints. A regression receipt must also resolve to a separate mutation-caught execution with reserved exit `42` of its locked code-owned mutation in an isolated project copy. Its four Codex/Grok receipts must resolve to actually launched durable ReviewBarrierStore/RunStore PASS evidence for the exact packet.
- Read records through `projectMapLearning`. Codex is the primary harness and Grok is the additional read-only consumer. Persist the exact projected bytes and digest at enqueue, and reject launch if the current projection, saved consumer, or prompt binding changes.
- Revalidate source, control-plane, and MAP-profile identity immediately before and after publishing the learning head. Write and fsync the promotion journal before record/head mutation; reconcile it under the SQLite mutex before close or projection. Treat any drift, stale provenance, schema error, digest mismatch, noncanonical candidate, unsafe path, or projection divergence as a blocked close; a post-publish failure or process death must restore the previous head and remove a newly introduced record.

This skill does not authorize provider calls, MCP changes, `mapify` installation or upgrade, Git operations, publication, or mutable Grok execution.
