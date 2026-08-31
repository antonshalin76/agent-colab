# R2-STG-00 architect audit packet

## Scope

This stage makes Codex the only required harness. Grok and Claude remain durable optional review lanes and rejoin pending current work after recovery.

Changed runtime owners:

- `src/domain/review.ts`: provider-role policy;
- `src/runtime/run-gate-unit-of-work.ts`: exact review closure;
- `src/cli.ts`: immediate and periodic deferred-lane activation;
- `src/app/service.ts`: MCP status projection.

## Safety invariants

- Codex auditor and critic both require canonical semantic PASS plus exact runner evidence.
- Helper PASS cannot replace either Codex receipt.
- Optional absence, ordinary failure, timeout, or disabled state does not block Codex work.
- Optional `CHANGES_REQUESTED`, malformed completed evidence, lane/attempt mismatch, and `needs_reconciliation` block closure.
- Recovery uses durable health admission, cooldown, attempt lease, source fingerprint, CAS lane transition, and deterministic idempotency keys.
- Rejoin does not reopen completed stages or change Codex ownership.

## Verification packet

- Focused runtime and routing suite: 82/82 PASS.
- Review, service, and MCP integration suite: 62/62 PASS.
- TypeScript typecheck: PASS.
- Immutable plan lock SHA-256: `c18672426c68c1699d9658654f611868d33a96ac4021992cce548ebc6e969cdf`.
- Start chain digest: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Live launches used before this audit: 5 confirmed; cost unknown; cap 24 launches and USD 10.

## Review questions

Return one verdict: `PASS` or `CHANGES_REQUESTED`.

1. Can any Grok or Claude health state stop an otherwise valid Codex-owned flow?
2. Can optional provider failure hide adverse completed evidence or an ambiguous launched attempt?
3. Does recovery admit current deferred work exactly once without a retry storm?
4. Is closure policy owned once and projected without reimplementation?
5. Did the change weaken authority, source binding, MAP, launch fencing, or reconciliation?

Reject benchmark-specific fixes, synthetic receipts, or advice that requires optional providers for availability.
