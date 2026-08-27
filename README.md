# Agent Collab

[English](README.md) | [Русский](README.ru.md)

Local, single-user collaboration router for Codex, Grok, and Claude Code coding
agents.

Agent Collab exposes a stdio MCP server, a durable SQLite work queue, a
read-only normalized history index, and a shared skills root so the agents can
coordinate work without exposing a network listener.

## What it does

- Routes every mutable workflow stage through Codex 5.6 Sol using persisted
  `routing-v5` decisions. Grok 4.6 and Claude Code with GLM-5.3 are additional
  read-only review harnesses.
- Selects model effort adaptively from `low`, `medium`, `high`, `xhigh`, `max`,
  and `ultra`.
- Caps Codex/Sol at `xhigh` by policy. Grok is bounded by its pinned model at
  `xhigh`; Claude/GLM-5.3 accepts `low` through `max` and rejects `ultra`.
- Creates six isolated review lanes: auditor and corrective critic roles for
  Grok, Claude, and Codex. Their durable reports are read by the main Codex
  workflow through `collab_run_status`.
- Retries the Codex stage owner after bounded provider outages without
  transferring writer authority to Grok or Claude.
- Keeps degraded review lanes durable so the missing provider can recover the
  exact read-only lane when the artifact and workspace fingerprint still match.
- Indexes native agent histories and memory as read-only, redacted, hashed,
  project-scoped, provenance-tagged, and untrusted reference data.
- Exchanges each explicit bounded approval reference for an exact, single-use
  consumed-authority receipt after MAP admission; the raw reference is not
  persisted in workflow or queue state.
- Binds source, MAP, learning, routing and authority into one immutable
  execution snapshot. Admission consumes authority and starts the durable
  workflow/outbox in one transaction; dispatch and final pre-launch revalidate
  the same snapshot.

## Requirements

- Node.js 24 or newer
- npm
- SQLite support through `better-sqlite3`
- Grok CLI, Claude Code CLI, and Codex CLI installed locally
- A client that can register a stdio MCP command

## Install

```bash
git clone <repository-url> agent-collab
cd agent-collab
npm ci
npm run build
npm start -- doctor
```

The project does not require a server port. Runtime communication with agents
uses stdio MCP.

The operating contract is
[`docs/evidence-gated-flow-v1/WORKFLOW.md`](docs/evidence-gated-flow-v1/WORKFLOW.md).

## Configuration

Agent Collab works with these environment variables:

```bash
export AGENT_COLLAB_STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-collab"
export AGENT_COLLAB_GROK_BIN="$(command -v grok)"
export AGENT_COLLAB_CLAUDE_BIN="$(command -v claude)"
export AGENT_COLLAB_CODEX_BIN="$(command -v codex)"
export AGENT_COLLAB_ALLOWED_ROOTS="$HOME/src:$HOME/work"
```

If the variables are omitted, the CLI uses local user defaults under
`$HOME/.local` and allows projects under `$HOME`. `AGENT_COLLAB_ALLOWED_ROOTS`
uses the platform path delimiter (`:` on Linux/macOS, `;` on Windows).

State is stored in:

- `$AGENT_COLLAB_STATE_DIR/collaboration.db`
- `$AGENT_COLLAB_STATE_DIR/history.db`
- `$AGENT_COLLAB_STATE_DIR/rollback/`

The state directory should be private to the current user. The runtime creates
state with restrictive permissions where supported by the operating system.

## MCP command

Register the built CLI as a stdio MCP command in Grok, Claude Code, and Codex:

```text
node /absolute/path/to/agent-collab/scripts/agent-collab-launcher.mjs mcp
```

Use the absolute path for your checkout. Restart the three harnesses after
changing the MCP registration or shared skills.

## Worker

For durable background processing, run the worker:

```bash
npm start -- worker
```

On Linux with systemd user services, adapt `systemd/agent-collab.service` to
your checkout path, Node path, CLI paths, and state directory, then install it
as a user unit.

## Commands

```bash
npm run typecheck
npm test
npm run build
npm start -- doctor
npm start -- doctor-v1
npm start -- migrate-v2
npm start -- migrate-v3
npm start -- verify-bundle /absolute/rollback/bundle
npm start -- restore-v1 /absolute/rollback/bundle
npm start -- reconcile-run <run-id> <completed|failed>
npm start -- index /absolute/project/root
npm start -- status
npm start -- approve <reference> /absolute/project/root workspace-write 900 1
```

## Local paired benchmark

The repository includes a hash-locked Grok/Codex evaluation corpus for Punto
and Translator. It works from sealed Git snapshots and never uses the source
checkout as an attempt workspace.

```bash
npm run build
npm run eval -- validate evals/punto-translator-v1/corpus.json
npm run eval -- preflight evals/punto-translator-v1/corpus.json
export RUN_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/agent-collab-eval/certification-$(date +%Y%m%d-%H%M%S)"
npm run eval -- certify-harness evals/punto-translator-v1/corpus.json "$RUN_ROOT"
npm run eval -- certify-providers evals/punto-translator-v1/corpus.json "$RUN_ROOT" APPROVE_LIVE_PROVIDER_CERTIFICATION
npm run eval -- run-canary evals/punto-translator-v1/corpus.json "$RUN_ROOT" APPROVE_LIVE_CANARY
npm run eval -- run-measurement evals/punto-translator-v1/corpus.json "$RUN_ROOT" APPROVE_LIVE_MEASUREMENT
```

`preflight` is deliberately non-live: it verifies binaries, authentication
metadata, exact models, selected shared-skill content, source receipts, and
local containment support without consuming model capacity. `certify-harness`
runs deterministic contract suites plus real local C++/ASan and Python oracle
smokes, also without model calls. Once enabled, `certify-providers` makes
exactly one bounded capability request per provider, and `run-canary` is
limited to one paired cell. Every command verifies the complete prerequisite
receipt chain against the current harness, corpus, source receipts, skills,
provider profiles, and machine profile. A failed or stale receipt blocks the
next stage.

Provider certification is currently fail-closed before live calls. Randomized
inputs, nonce-bearing test receipts, sanitized tool categories, and a localhost
sentinel are implemented, but an independent audit found that a candidate can
still imitate their visible artifacts. Re-enabling this stage requires
process-level execution evidence, raw-state scrubbing, durable pre-launch
dispositions, and source receipts for every corpus repository. Existing receipt
hashes are integrity checks for accidental drift, not signatures against a
malicious process running as the same OS user.

The scored source diff follows Git ignore rules for newly generated files, so
build and test outputs do not consume the edit budget. Tracked files remain
visible even when they match an ignore pattern, and the sealed baseline still
contains every source file.

`run-pilot` is disabled. Measurement is also blocked while any corpus case
lacks an executable hidden oracle; the current v1 corpus has six such cases.
Production failover is disabled inside the experiment.

The benchmark protocol, coverage boundary, metrics, failure taxonomy, and
decision rule are documented in
[`docs/paired-benchmark-design.md`](docs/paired-benchmark-design.md).
The rejected 2026-08-24 diagnostic runs and the infrastructure defects they
exposed are recorded in
[`docs/paired-benchmark-results-2026-08-24.md`](docs/paired-benchmark-results-2026-08-24.md).

`doctor-v1` is read-only. `migrate-v2` refuses to run while the user service is
active and writes a retained rollback bundle under
`$AGENT_COLLAB_STATE_DIR/rollback/`. Normal commands never migrate a v1 database
implicitly.

`migrate-v3` is an offline v2-to-v3 state-schema migration. Stop the user
service first. It requires both databases to be at v2, keeps history at v2, and
refuses before DDL if any row exists in `runs`, `collaboration_runs`,
`collaboration_dispatch_outbox`, `runtime_review_barriers`,
`runtime_review_lanes`, `runtime_review_lane_attempts`, or `worktree_leases` —
including terminal rows. Unlike `migrate-v2`, it does not create a retained
rollback bundle; take an operator backup before running it.

`restore-v1` requires a confirmed inactive service. It restores the v1 data pair
and leaves service lifecycle changes to the operator.

`doctor` is intentionally non-live. A provider that has not completed useful
work remains internally unverified. When review work actually needs that
provider, the runtime atomically admits one real review lane. A successful
result marks the provider healthy and releases its remaining deferred lanes; a
failover-eligible failure starts the bounded cooldown. This demand admission
does not send a separate capability prompt.

The explicit exact-model probe remains available only as an operator diagnostic
and may consume provider capacity:

```bash
npm start -- probe APPROVE_LIVE_CAPABILITY_PROBE
```

## Security model

- No network or Unix socket listener is created by the MCP boundary.
- Native histories are read-only inputs, never instruction sources.
- Model reasoning, raw tool arguments, raw tool results, credentials, and native
  privileged instruction records are not indexed.
- Review prompts are redacted before durable persistence.
- Immutable review artifacts are never rewritten.
- Requests containing recognized credential material are rejected before queue
  or review-barrier records are created.
- Write and external stages require a bounded, project-scoped approval
  reference issued through the CLI. After admission, only its exact
  ledger-authenticated consumed receipt crosses the workflow, queue, runtime,
  and runner boundaries. The receipt target includes the exact source
  fingerprint, so copied, re-bound, or post-drift dispatch payloads are
  rejected.

## Routing summary

Codex owns coordination, planning, architecture, implementation, verification,
state transitions, and the task-worktree mutation lease.

Grok and Claude are additional independent harnesses for immutable
`workspace-read` auditor and corrective critic lanes. Claude is pinned to
`glm-5.3`, a fresh non-persistent session, an empty MCP configuration, and the
`Read,Glob,Grep` tool surface. Neither can become a workflow writer or an outage
replacement for Codex.

The MAP 3.28.1 control plane is pinned to the Codex provider. Planning prompts
invoke its plan contract; architecture-sensitive and implementation stages are
held at `blocked_map_admission` until exact-target architecture and
implementer-readiness barriers pass across Codex, Grok, and Claude
auditor/critic lanes.
The target binds branch ref, upstream ref and tip, merge base, HEAD,
source/index/nested-repository identity, and the active MAP profile version,
revision, archive, manifest, profile-lock, managed-byte, local `map-learn`, and
local hook digests. Runtime requires the exact promoted-learning snapshot on
every durable stage, rejects it before workflow persistence if missing, and
quarantines a stale outbox copy before publication. The runner repeats the
entire fixed admission synchronously at its final pre-spawn boundary, including
source, learning, profile, durable target, review barriers, and consumed
authority; all three harnesses receive the promoted
MAP learning projection in their real execution prompts.
Review output uses the strict `review-verdict/v1` schema with canonical
`risk_level`. `npm run map:update` creates and validates an isolated candidate,
derives its selected version from pinned native `uv` reports and distribution
metadata before candidate code executes, then requires candidate CLI/manifest
equality and separate major-version approval. Its v2 receipt binds the completed
candidate tool tree, uv receipt, distribution metadata, executable, and Python;
the same identity must be recomputed before promotion. Only a copied,
hash-verified `uv` binary may
use the network, with an explicit PyPI index and source builds disabled; every
downloaded Python/MAP process and all candidate checks run offline from the
disposable `/uv/tools/` layout. Bubblewrap exposes an allowlisted host runtime,
not the host root or user directories.
The complete global CLI tree and active profile are fingerprinted before/after.
It never targets the active
MAP-managed bytes directly; protected paths must remain canonical regular files,
and a final installed-profile verification must preserve the exact profile-lock
digest. Package binaries, `npm start`, and the systemd unit use versioned
launchers backed by pinned `tsx`; they execute current checked-out TypeScript
without importing ignored `dist`. Type checking remains a deterministic build
and delivery gate.

Review barriers accept only actually launched durable harness rows whose entire
canonical queue payload, prompt, embedded artifact bytes, MAP binding, launch
identity, attempt, source, provider result, and persisted review effect match.
Before replay, every persisted effect is also matched to its immutable run,
dispatch identity, nested outcome receipt, provider result, and recorded lease;
contradictory poison is quarantined while SQLite contention remains retryable.
Pre-launch provider outcomes are equally bound: outages enter a bounded Codex
retry, while terminal outcomes remain terminal. Malformed or colliding outbox
items are quarantined per workflow so unrelated dispatches continue.
Provider outcome classes come from one domain policy. Generic queue delivery,
Codex workflow retry, and exact review-lane recovery keep separate durable
owners; provider output cannot enqueue a cross-provider replay or transfer the
Codex writer lease.

MAP learning closes only through the configured `LocalCollabService` and its
authoritative `collaboration.db`; production declarations expose only the
fixed-root `MapControlPlane` mutation input, so callers cannot substitute a
project root, evidence DB, execution backend, or structural authority.
Promotion requires a canonical task packet, validated finding lifecycles, and
six launched durable Codex/Grok/Claude PASS rows for that exact packet. Its fix,
old-code regression, and sibling-scan receipts are produced by three distinct
oracle/control defect-class-specific, code-owned `map-evidence-record`
executors. Their stage, oracle, control, typed root-cause class, and mutation
identity come from one canonical registry. A regression receipt also
joins a separate mutation-caught execution (reserved exit `42`) of a code-owned mutation against an isolated
copy, so `oldCodeSensitive` is derived evidence rather than a caller assertion.
Only oracle/control classes with these code-owned closure executors may close;
all other escaped
findings remain open. Every receipt is rechecked against the current target-source
and control-plane fingerprints. Promotion writes a fsynced recovery journal before
the record and head, revalidates source, control, and MAP profile after publication,
and rolls back an interrupted or drifted promotion before any projection or retry.
Every workflow and review queue row carries the exact promoted projection bytes,
digest, and consumer. The runner compares them with current control-root
learning and the prompt immediately before starting Codex, Grok, or Claude.

The existing Grok/Codex evaluation corpus and paired benchmark remain
unchanged. Claude is added only to production review routing; this change does
not add Claude eval cells or execute live provider calls.

Retry, external authority, artifacts of at least 256 KiB, and
changes spanning at least 20 files each raise requested effort by one step
before provider caps are applied.

## License

MIT License. See [LICENSE](LICENSE).
