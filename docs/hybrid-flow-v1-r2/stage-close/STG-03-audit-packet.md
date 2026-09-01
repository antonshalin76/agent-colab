# STG-03 stage-close audit packet

## Scope and identity

- Plan: `agent-collab-hybrid-flow-v1-r2`. Immutable plan, contracts, schemas, evals, and evidence protocol were not modified.
- Plan SHA-256: `af9191ea30d500de7f53cfdb57a890bfc7c1e55df3d3e738ed667bce7a787224`; start receipt SHA-256: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Exact source commit: `cf0f1801cd21f3368a0572a6dcd6937f9fc3fb50`, pushed to `origin/master`.
- Reviewed dirty-workspace fingerprint before the source commit: `a6ecbb4c1535e9ec24842d9be589560a2f8fcb01e7d84e5c47490d108853da55`.
- Source manifest fingerprint: `77aded37d2f062601b5bf40dcd284052db90bb2d31b4e44746891f0737acd6a8`.
- Built `dist/cli.js`: `59dee4901ce66067ec88361ae870ad2ad7e24dae10a3ae9dfc5be31e01d8e791`.
- Production `mcp` and `worker` entrypoints remain quarantined. Graph execution remains disabled.

## Architecture verdict

`PASS`. STG-03 owns one additive state boundary: the guarded schema-v4 migration, pinned state-root lease, database access fence, restore authority, graph persistence stores, constructor rollback, and their failure tests. The implementation does not add a scheduler or an execution path.

The state-root lease binds admission to a canonical root, a pinned `/proc/self/fd` path, and a held filesystem lock. Database access requires an unforgeable branded borrow. Raw database symbols, statement database handles, fluent escape paths, cached statements, iterators, cross-root histories, and stale leases are rejected. Migration and restore use the pinned root, journal generations and hashes, and validate terminal state. Restore persists and fsyncs `restore_consumed`, replaces and fsyncs the database, retires the descriptor, then reopens it.

The final critic found no remaining activation or authority bypass. The final architect-auditor accepted the corrected C4 model as a CLI/stdio-MCP process with private SQLite storage.

## Gates and review topology

- Focused migration, fence, store, restore, compatibility, CLI, and admission gate: `8/8` files and `138/138` tests `PASS`.
- Constructor and fixture-contract cluster: `8/8` files and `102/102` tests `PASS`.
- Flow integration gate: `24/24` files and `454/454` tests `PASS` in `271.28 s`.
- The two filesystem-sensitive app-service cases pass `2/2` in isolation in `4.13 s`.
- Typecheck, production build, MAP verification, C4 validation, and diff check: `PASS`.
- Codex auditor and Codex critic: semantic `PASS` on the exact source fingerprint.
- Grok and Claude auditor/critic lanes: `optional_unavailable`; the fixed cap is exhausted at `40/40`, so no new launch was admitted.
- Ambiguous launched attempts: `0`. No optional receipt was synthesized.
- Duplicate-owner scan: `/root` owned source integration and evidence; `/root/release_audit` and `/root/activation_surface` were read-only reviewers.

The extra monolithic repository run is `INCONCLUSIVE`, not `PASS` or `FAIL`: its worker entered kernel D state in `jbd2_log_wait_commit` twice. The first attempt found a real fixture-contract defect, which was closed across the complete constructor boundary. The second attempt left two default five-second timeouts under filesystem contention; both pass in isolation. This non-oracle run does not replace or weaken the frozen mandatory gates.

## Code surface delta

- Total commit: `47` files, `+8699/-2543` lines.
- Product source: `+2740/-408`, net `+2332` lines.
- Tests: `+2179/-438`, net `+1741` lines.
- C4 index: `+3780/-1697`, net `+2083` lines.
- The product increase buys guarded v4 state persistence and stronger authority properties. It does not preserve an alternate custom migration, scheduler, or graph-execution fallback.

## Progress estimates

- Active STG-03 recovery/state/policy goal: previous `0%`, current `100%`, delta `+100 pp`.
- Broader production graph-runtime maturity: previous approximately `18%`, current approximately `26%`, delta `+8 pp`.
- Frozen implementation plan: previous `3/13 = 23.08%`, current `4/13 = 30.77%`, delta `+7.69 pp`.

## Documentation and publication

- Contract hash: `2f223433e67874906c1aee503c18513c41e02f21cfcd34551245c4b0ee341d32`.
- MCP schema hash: `22700454d3a6a34ea76b2bd8d0b748bd08d043227526aedb66a629585e6dae23`.
- State-v4 DDL hash: `43ae43d139ac44f25d2132439600a5405c1082a8278aca60cffeab5e479ead8b`.
- Eval contract hash: `561183ec6181e4d45e468a9b749ffc4f6791eebb9cce6d89d923bdf9bb5a6edd`; eval launcher hash: `3b0621f1039390ab37a8ed63184f67f235514df9afe897268e06c9b8468f8851`.
- C4 hash: `e96ba28f603025c796c6e328226335c4ee94892da7e0ecec1241104679865784`.
- Local source commit and advertised `origin/master` both equal `cf0f1801cd21f3368a0572a6dcd6937f9fc3fb50`.

## Residual work

STG-03 does not authorize graph execution or restore the retired linear runtime. STG-04 through STG-12 remain open. STG-04 owns event and session telemetry on the quarantined linear path.
