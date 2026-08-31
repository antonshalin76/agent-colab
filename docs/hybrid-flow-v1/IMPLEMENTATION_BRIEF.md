# Implementation brief: Hybrid Agent Flow v1

## Goal

Add a deterministic DAG scheduler above the current bounded collaboration
workflow, then attach Prime Agent as a read-only RPC runner. Preserve the entire
safety kernel and treat the queue as an execution lane for ready nodes only.

## C4 orientation

- Container: `app` — local CLI/MCP control plane.
- Primary components: `workflow`, `runtime`, `store`, `mcp`, `runners`.
- Preserved authority components: `security`, `worktree`, `flow`.
- Supporting components: `worker`, `migration`, `history`, `app`.
- Critical edges: `app -> runtime`, `runtime -> store`, `store -> workflow`,
  `runners -> runtime`, `workflow -> domain`.

## Core decisions

- `GraphFlow/v1` is immutable and validated with
  `@dagrejs/graphlib@4.0.5`.
- Node outputs use JSON Schema and `ajv@8.20.0`.
- Conditions use only terminal outcome or a declared `NodeResult.route`.
- Each ready node becomes one existing bounded collaboration workflow.
- Result acceptance creates a durable intent; node admission then captures
  source, inputs, memory, and MAP just in time and consumes exact authority in a
  second atomic unit of work.
- Concurrent nodes use atomic worst-case token/cost reservations.
- Session memory is a bounded broker-owned checkpoint, not provider memory.
- SQLite events are durable telemetry; OpenTelemetry is an optional projection.
- Prime Agent remains read-only and shadow-only until its exact gates pass.

## Suggested order

1. Freeze the plan and implementation identity.
2. Add contracts and validators.
3. Add compatibility runtime and schema v4.
4. Capture telemetry on the existing linear path.
5. Add typed results and session checkpoints.
6. Implement and shadow-test the pure graph reducer.
7. Add node-time admission as a no-dispatch dry run.
8. Enable the sequential graph bridge.
9. Enable read-only fan-out/fan-in/routes.
10. Add the flow MCP API, downstream authority, and cancellation.
11. Add Prime as a read-only shadow subprocess beneath routing-v5.
12. Run paired evaluation and the cleanup/cutover decision.

## Must-pass checks

```bash
npm run test:flow
npm run typecheck
npm run build
npm run map:verify
python3 /home/anton/.agents/skills/repo-c4-scan/scripts/validate_repo_c4.py repo-c4.json
git diff --check
```

The normative requirements are in `IMPLEMENTATION_PLAN.md`; this brief is a
non-normative starting map.
