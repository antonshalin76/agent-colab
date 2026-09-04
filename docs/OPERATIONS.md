# Agent Collab review runtime operations

This runbook owns the production review-only runtime. The legacy linear MCP,
worker, delegation and dispatcher routes are permanently quarantined. Graph
execution remains disabled until its later locked-plan stage.

## Runtime profiles

| Process | Authority | Expected owner |
| --- | --- | --- |
| `review-worker` | Mutates only durable review queue, provider health and review evidence | systemd user service |
| `review-mcp-codex` | Three review tools; exact `codex-mcp-client` handshake required | Codex only |
| `review-mcp-status` | `collab_status` only, SQLite read-only | Grok and Claude Code |

Codex is required. Grok and Claude Code are optional reviewers: their absence
does not block a review barrier, their deferred lanes remain durable, and the
worker probes and rejoins them only when unresolved review demand exists.
Availability never grants either helper mutation authority.

## Common environment

Use absolute paths. Keep the state directory private to the service user.

```bash
export AGENT_COLLAB_ROOT=/home/anton/Source/agent-collab
export AGENT_COLLAB_STATE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/agent-collab"
export AGENT_COLLAB_CODEX_BIN="$(command -v codex)"
export AGENT_COLLAB_GROK_BIN="$(command -v grok || true)"
export AGENT_COLLAB_CLAUDE_BIN="$(command -v claude || true)"
export AGENT_COLLAB_ALLOWED_ROOTS=/home/anton/Source
```

Never place a private signing key, token or credential in a command argument,
log, repository or promotion packet.

## Fresh installation

Link the canonical shared skills before any database is created. Existing
non-matching harness skill directories are rejected and are never overwritten.

```bash
cd "$AGENT_COLLAB_ROOT"
npm ci
npm run typecheck
npm run build
npm start -- review-skills-link
npm start -- review-readiness
npm start -- review-initialize
```

`review-readiness` exits non-zero only when mandatory Codex is not ready. It
reports missing Grok or Claude as optional degradation.

Install and start the worker after copying and reviewing the supplied unit:

```bash
systemctl --user mask agent-collab.service
install -Dm600 systemd/agent-collab.service \
  "$HOME/.local/share/systemd/user/agent-collab-reviewed.service"
systemctl --user daemon-reload
systemctl --user enable --now agent-collab-reviewed.service
systemctl --user is-active agent-collab-reviewed.service
npm start -- status
```

## MCP registration

Register the mutating profile only in Codex. Register the status-only profile
in both helper harnesses.

```bash
codex mcp add agent-collab -- node /home/anton/Source/agent-collab/scripts/agent-collab-launcher.mjs review-mcp-codex
claude mcp add --scope user agent-collab-status -- node /home/anton/Source/agent-collab/scripts/agent-collab-launcher.mjs review-mcp-status
grok mcp add --scope user agent-collab-status -- node /home/anton/Source/agent-collab/scripts/agent-collab-launcher.mjs review-mcp-status
```

Remove any old entry that starts `review-mcp`, `mcp`, or `worker`. Restart each
harness after changing its MCP or skill configuration. Verify tool discovery:
Codex must see the three review tools; Grok and Claude must see only
`collab_status`.

## Controlled v3 to reviewed-v4 adoption

This sequence is for an existing v3 state and v2 history database. Do not use
`review-initialize` on an existing installation.

1. Freeze the exact candidate commit, pass the production test gate and push
   that exact commit to the configured remote ref.
2. Obtain two independent Codex PASS artifacts, one `auditor` and one `critic`,
   for that exact source identity. Each must use `review-receipt/v2`, a distinct
   run, attempt and session identity, and `review-verdict/v1` with only `info`
   findings.
3. Sign one promotion with an operator-controlled Ed25519 key outside the
   repository.
4. Stop both unit names, keep the legacy unit persistently `/dev/null`-masked,
   terminate harness-spawned MCP processes, and stage the distinct reviewed unit.
5. Adopt, preflight and prepare while the reviewed unit remains persistently
   activation-masked by its higher-precedence configuration entry.
6. Verify `PROJECTION_CURRENT`; activate only through the reviewed-unit gate.

Create the signing key once and retain it outside the repository:

```bash
install -d -m700 "$HOME/.config/agent-collab"
openssl genpkey -algorithm ED25519 -out "$HOME/.config/agent-collab/reviewed-v4-private.pem"
openssl pkey -in "$HOME/.config/agent-collab/reviewed-v4-private.pem" -pubout \
  -out "$HOME/.config/agent-collab/reviewed-v4-public.pem"
chmod 600 "$HOME/.config/agent-collab/reviewed-v4-private.pem" \
  "$HOME/.config/agent-collab/reviewed-v4-public.pem"
```

Configure the exact remote trust and build an exclusive promotion file:

```bash
export AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_URL=git@github.com:antonshalin76/agent-colab.git
export AGENT_COLLAB_REVIEWED_SOURCE_REMOTE_REF=refs/heads/master
export AGENT_COLLAB_REVIEWED_SOURCE_PRIVATE_KEY_FILE="$HOME/.config/agent-collab/reviewed-v4-private.pem"

npm start -- reviewed-source-promote \
  /absolute/evidence/codex-auditor.json \
  /absolute/evidence/codex-critic.json \
  /absolute/evidence/reviewed-v4-promotion.json \
  2026-12-31T23:59:59Z \
  reviewed-v4-production-candidate
unset AGENT_COLLAB_REVIEWED_SOURCE_PRIVATE_KEY_FILE
```

The command refuses a dirty executing source, a commit not advertised by the
exact remote ref, an existing output, invalid or non-distinct reviews, and a
private key that is not an owner-owned canonical `0600` Ed25519 file.

Perform the migration:

```bash
systemctl --user stop agent-collab.service
systemctl --user mask agent-collab.service
systemctl --user is-active agent-collab.service           # must print inactive
systemctl --user is-active agent-collab-reviewed.service  # must print inactive or unknown
install -d -m700 "$HOME/.local/state/agent-collab/service-unit-backups"
npm start -- review-service-stage \
  "$HOME/.local/state/agent-collab/service-unit-backups/reviewed-v4-cutover"

export AGENT_COLLAB_REVIEWED_SOURCE_PUBLIC_KEY_FILE="$HOME/.config/agent-collab/reviewed-v4-public.pem"
ADOPTION_SHA="$(npm --silent start -- reviewed-source-adopt \
  /absolute/evidence/reviewed-v4-promotion.json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).receiptSha256))')"

npm start -- stg04-close-preflight "$ADOPTION_SHA"
npm start -- stg04-close-prepare "$ADOPTION_SHA"
npm start -- stg04-close-status "$ADOPTION_SHA"
```

`stg04-close-prepare` repeats service, open-file, source, remote and database
identity checks before and after the migration kernel. It writes a retained
backup and durable one-shot authorization/completion records. A crash is
recovered by rerunning the same command with the same adoption SHA; a different
source or target is rejected.

`review-service-stage` never unmasks or replaces `agent-collab.service`; that
legacy name must remain a persistent `/dev/null` mask, including across reboot.
It disables the separate `agent-collab-reviewed.service`, atomically installs
the exact reviewed unit under `~/.local/share/systemd/user`, reloads systemd,
rejects a legacy effective `ExecStart` or any reviewed-unit drop-in, and places
a persistent `/dev/null` activation mask under the higher-precedence
`~/.config/systemd/user`. Both stage and activation use one exclusive cutover
lock. The reviewed unit is part of the signed source manifest.

Only after status reports `PROJECTION_CURRENT`, activate through the same gate:

```bash
npm start -- review-service-activate "$ADOPTION_SHA"
npm start -- status
```

The activation command repeats the source-byte, legacy persistent-mask and
effective systemd checks, requires exact STG-04 state, removes only the reviewed
unit's persistent activation mask, reloads and verifies that the effective
fragment is exactly the lower-precedence signed unit, then enables and starts
it. Any failure disables and persistently remasks the reviewed name. Do not
manually unmask or start either unit during cutover.

Then restart the harnesses, verify MCP discovery, and submit one bounded
Codex-originated read-only review smoke. Do not use the paid benchmark as a
startup probe.

## Recovery and observation

`npm start -- status` and `review-mcp-status` never initialize or mutate the
database. They report provider health, retry time, recovery generation,
deferred review count and exact review queue counts. The worker writes compact
JSON events only for startup, material queue/provider recovery, failure and
shutdown.

When Grok or Claude disappears, leave the worker running. Codex auditor and
critic lanes remain mandatory and can complete the barrier. Deferred helper
lanes are automatically probed and rejoined when the provider becomes usable
again and the source fingerprint is still current.

Use the explicit live probe only for operator diagnosis; it may consume model
capacity:

```bash
npm start -- probe APPROVE_LIVE_CAPABILITY_PROBE
```

If a run reaches `needs_reconciliation`, never synthesize successful review
evidence. Reconcile it as failed and let the runtime create a fresh exact lane:

```bash
npm start -- reconcile-run <run-id> failed
```

## Security boundary

The `clientInfo.name=codex-mcp-client` check prevents accidental helper
registration from receiving the mutating surface. It is a launch-profile
check, not authentication against a hostile same-UID process.

The runtime defends against stale or forged unsigned promotion packets,
wrong remote refs, source/mode/symlink drift, target replacement, ordinary
concurrent SQLite clients, crashes and replay. A malicious process with the
same OS UID can still tamper with that user's files, environment or process
memory. Environments requiring that attacker model must run signing and the
service under separate OS identities with an external policy boundary such as
SELinux or AppArmor.
