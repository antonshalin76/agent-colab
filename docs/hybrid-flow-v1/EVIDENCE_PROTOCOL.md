# Hybrid Agent Flow v1 — evidence protocol

This file is normative for `agent-collab-hybrid-flow-v1@1.0.1`. Canonical JSON
means RFC 8785 bytes. Digests are lower-case SHA-256 hex.

## 1. Start receipt

`IMPLEMENTATION_START.json` has schema `implementation-start/v1` and exactly:
`schemaVersion`, `planId`, `normativePackageSha256`, `planAnchorCommit`,
`sourceBaselineHead`, `implementationHead`, `branch`, `worktree`, `mapSha256`,
`routingPolicy`, `authorityConsumer`, `authorityReceiptSha256`,
`commitPushScope`, `liveProviderScope`, `startedAt`, and `startSha256`.
`startSha256` hashes canonical bytes without itself.

Creation uses create-if-absent (`O_EXCL`) after authority consumption. A
byte-identical replay returns the existing receipt; any different second value
is `blocked_plan_integrity`. `PLAN_LOCK.json` is the trusted package manifest;
its hash is `normativePackageSha256` and the Git anchor is recorded only here.

## 2. Progress ledger and projection

Before schema v4, canonical progress is one create-if-absent JSON receipt per
transition named `stage-close/pre-v4/NNNNNN-EVENT_ID.json`, where `NNNNNN` is
the zero-padded sequence and `EVENT_ID` matches `[A-Za-z0-9._:-]+`; receipts are
hash-chained from the start receipt.
Amendments are forbidden in this bootstrap window: a normative discovery aborts
the run and requires a new plan revision. At v4 migration the verified chain is
imported atomically into `plan_progress_events`; thereafter SQLite is canonical
and JSONL/Markdown are projections published through `plan_progress_outbox`.
Each `PlanProgressEvent/v1` contains `eventId`,
`sequence`, `previousEventSha256`, `eventType`, `planId`,
`effectivePlanSha256`, `stageId`, `gateId`, `sourceFingerprint`, `actor`,
`commandOrOracle`, `inputHashes`, `outputHashes`, `attemptIds`,
`reviewReceiptHashes`, `artifactPaths`, `terminalResult`, `recordedAt`, and
`eventSha256`. The event digest hashes canonical bytes without itself.

The verifier checks the start receipt, contiguous sequence/hash chain, exact
plan/stage/gate IDs, artifact hashes, terminal oracle, required review receipts,
and invalidations. The genesis event has `previousEventSha256 = startSha256`
and `effectivePlanSha256 = PLAN_LOCK.planSha256`; every event also carries the
same `startSha256` chain root. The verifier regenerates every checkbox; it never trusts Markdown.
Manual `[x]` edits are overwritten. Before this verifier passes, the maximum
display state is `UNVERIFIED_PROJECTION`.

`STG-00` owns NEW `scripts/verify-implementation-progress.mjs`, NEW
`scripts/render-implementation-progress.mjs`, their JSON schemas, and NEW
`tests/implementation-progress.test.ts`. Negative controls cover forged `[x]`,
broken chain, duplicate sequence, wrong effective plan, missing artifact,
missing review, and an invalidated descendant.

## 3. Amendments

An amendment has canonical schema `implementation-amendment/v1`, a strictly
contiguous ordinal, baseline and previous effective hashes, affected stage/gate
IDs, reason/evidence hashes, exact contract/acceptance/authority delta,
invalidated event IDs, authority consumer/receipt hash, and
`amendmentSha256`. Its human-readable `.md` is a projection.

The effective hash is:

```text
SHA256(canonical({
  baselinePlanSha256,
  previousEffectivePlanSha256,
  ordinal,
  amendmentSha256
}))
```

Amendments are accepted only after the v4 import. Acceptance uses one
`BEGIN IMMEDIATE` transaction to consume exact amendment
authority, append acceptance plus descendant-invalidation events, and enqueue
projection publication. JSONL/Markdown may lag and are repaired idempotently
from SQLite. No product effect is erased. A conflicting ordinal/hash blocks
progress. A major objective change requires a new plan ID.

## 4. Stage-close packet

Every packet includes exact plan/source/MAP/routing/dependency/artifact hashes,
commands and typed outputs, reconciliation state, architect-auditor verdict,
required isolated review receipts, duplicate-owner scan, docs/C4 hash, code
surface delta, skipped checks, residual risks, and publish receipt when
authorized.

It also includes two evidence-backed percentages: active
recovery/state/policy-goal progress and broader autonomous-Geek-goal progress,
each with the previous value and delta. Missing estimates or missing prior
checkpoint make stage close incomplete.
