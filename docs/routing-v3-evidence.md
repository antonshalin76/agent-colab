# Routing v3 evidence note

Date: 2026-08-24

## Grok self-assessment

The document `2026-08-23-grok-4.6-vs-codex-sol-5.6-xhigh.md` provides
hypotheses, not evidence for permanent task ownership. It combines model
capability, host-agent tooling, and behavior from one conversation.

Claims such as “better coordination in this environment” mostly describe the
harness available to Grok. The claim that Codex is weaker at UI also conflicts
with OpenAI's GPT-5.6 guidance, which reports improvements in frontend layout,
visual hierarchy, and design judgment.

Vendor benchmarks do not establish one winner. xAI reports Grok 4.6 High ahead
of GPT-5.6 Sol Max on CursorBench 3.2 and FrontierCode 1.1. Its table reports
GPT-5.6 Sol ahead on DeepSWE 1.1 and Terminal-Bench 3.0. Different harnesses and
reasoning settings prevent a direct ownership conclusion for this system.

Sources:

- https://x.ai/news/grok-4-6
- https://docs.x.ai/developers/grok-4-6
- https://openai.com/index/gpt-5-6/
- https://developers.openai.com/api/docs/guides/latest-model

## Provisional allocation

`routing-v3` retains the v2 canary allocation:

- Grok: planning, PRD, UI/UX, BDD, and e2e scenario work.
- Codex: coordination, architecture, TDD coding, unit testing, audits,
  corrective criticism, code review, and e2e infrastructure.
- Independent checkpoints use four isolated lanes: auditor and critic from
  each provider.

Planning and coordination remain weakly evidenced. Promotion to a permanent
policy requires paired local evaluations.

## Adaptive effort and limits

The adaptive calculation uses the requested ladder
`low < medium < high < xhigh < max < ultra`. Persisted decisions and command
builders accept only executable values `low < medium < high < xhigh`.

The pinned local capability catalogs were checked on 2026-08-24:

- `gpt-5.6-sol` advertises `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.
  Router policy limits Codex/Sol to `xhigh`.
- `grok-4.6` advertises `low`, `medium`, `high`, and `xhigh`. Grok has no router
  policy maximum; its current model capability limits execution to `xhigh`.

Fallback, retry, external scope, an artifact of at least 262144 bytes, and a
change set of at least 20 files each raise the requested effort by one step.
The router applies the model capability and provider policy after calculating
all modifiers. A constrained decision records exactly one final reason:

- `provider_policy_limit:gpt-5.6-sol:xhigh` for the Codex policy cap;
- `model_capability_limit:grok-4.6:xhigh` for the current Grok model limit.

The runner recomputes the expected effort from the stage baseline and ordered
reasons. It rejects unsupported executable values, foreign limit reasons,
stage mismatches, missing identity, and session or decision drift from the
persisted workflow or review dispatch identity before launch.

`routing-v3` changes the durable reason grammar. Review-store migration keeps
historical `routing-v2` decisions and versions, expands the SQLite constraint
to admit both versions, and writes new rows as `routing-v3`. Nonterminal v2
lanes become `failed`; their scheduled attempts become `needs_reconciliation`.
Integrity and foreign-key checks run before and inside the migration
transaction, so a corrupt database remains unchanged and fails on every open.

## Verification boundary

Review retries create an append-only attempt with a new session, idempotency
key, decision, and `retry` reason. Previous decisions remain evidence.

The explicit live probe verifies exact-model selection, CLI readiness, and the
structured response contract. Neither provider supplies independent server-side
effort attestation. The system verifies effort at the trusted command boundary
and in immutable attempt metadata.

## Promotion rule

A policy change requires equal artifacts, permissions, tool access, timeout,
effort, deterministic acceptance checks, cost evidence, and independent
reviews. Provider quota, missing token caps, environment failure, or unequal
harness conditions produce `inconclusive`.
