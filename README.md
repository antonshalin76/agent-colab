# Agent Collab

Local, single-user collaboration router for Grok and Codex coding agents.

Agent Collab exposes a stdio MCP server, a durable SQLite work queue, a
read-only normalized history index, and a shared skills root so both agents can
coordinate work without exposing a network listener.

## What it does

- Routes stages between Grok 4.6 and Codex 5.6 Sol using persisted `routing-v3`
  decisions.
- Selects model effort adaptively from `low`, `medium`, `high`, `xhigh`, `max`,
  and `ultra`.
- Caps Codex/Sol at `xhigh` by policy while leaving Grok uncapped by router
  policy and bounded only by the effort levels advertised by the pinned model.
- Creates isolated review lanes for auditor and critic roles on each provider.
- Falls back to the healthy provider on authentication, quota, rate limit,
  timeout, overload, missing CLI, or model outage.
- Keeps degraded review lanes durable so the missing provider can replay them
  after recovery when the artifact and workspace fingerprint still match.
- Indexes native agent histories and memory as read-only, redacted, hashed,
  project-scoped, provenance-tagged, and untrusted reference data.
- Requires explicit bounded approval references for write or external-authority
  stages.

## Requirements

- Node.js 24 or newer
- npm
- SQLite support through `better-sqlite3`
- Grok CLI and Codex CLI installed locally
- A client that can register a stdio MCP command

## Install

```bash
git clone <repository-url> agent-collab
cd agent-collab
npm ci
npm run build
node dist/cli.js doctor
```

The project does not require a server port. Runtime communication with agents
uses stdio MCP.

## Configuration

Agent Collab works with these environment variables:

```bash
export AGENT_COLLAB_STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-collab"
export AGENT_COLLAB_GROK_BIN="$(command -v grok)"
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

Register the built CLI as a stdio MCP command in both Grok and Codex:

```text
node /absolute/path/to/agent-collab/dist/cli.js mcp
```

Use the absolute path for your checkout. Restart Grok and Codex after changing
the MCP registration or shared skills.

## Worker

For durable background processing, run the worker:

```bash
node dist/cli.js worker
```

On Linux with systemd user services, adapt `systemd/agent-collab.service` to
your checkout path, Node path, CLI paths, and state directory, then install it
as a user unit.

## Commands

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js doctor
node dist/cli.js doctor-v1
node dist/cli.js migrate-v2
node dist/cli.js verify-bundle /absolute/rollback/bundle
node dist/cli.js restore-v1 /absolute/rollback/bundle
node dist/cli.js reconcile-run <run-id> <completed|failed>
node dist/cli.js index /absolute/project/root
node dist/cli.js status
node dist/cli.js approve <reference> /absolute/project/root workspace-write 900 1
```

`doctor-v1` is read-only. `migrate-v2` refuses to run while the user service is
active and writes a retained rollback bundle under
`$AGENT_COLLAB_STATE_DIR/rollback/`. Normal commands never migrate a v1 database
implicitly.

`restore-v1` requires a confirmed inactive service. It restores the v1 data pair
and leaves service lifecycle changes to the operator.

`doctor` is intentionally non-live. Authentication readiness leaves a provider
in `probing`. An explicit exact-model structured capability probe changes it to
`healthy`; the probe consumes provider capacity and is never started
implicitly:

```bash
node dist/cli.js probe APPROVE_LIVE_CAPABILITY_PROBE
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
- Write and external stages require a bounded, project-scoped approval reference
  issued through the CLI.

## Routing summary

Grok is preferred for planning, PRD, UI/UX, BDD, and e2e testing.

Codex is preferred for coordination, architecture, TDD coding, unit testing,
audits, critics, code review, and e2e infrastructure.

Retry, degraded fallback, external authority, artifacts of at least 256 KiB, and
changes spanning at least 20 files each raise requested effort by one step
before provider caps are applied.

## License

MIT License. See [LICENSE](LICENSE).
