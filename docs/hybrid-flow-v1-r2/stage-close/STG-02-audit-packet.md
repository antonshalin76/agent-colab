# STG-02 stage-close audit packet

## Scope and identity

- Plan: `agent-collab-hybrid-flow-v1-r2`; immutable plan, contracts, schemas, evals, and evidence protocol were not modified.
- Plan SHA-256: `af9191ea30d500de7f53cfdb57a890bfc7c1e55df3d3e738ed667bce7a787224`; start receipt SHA-256: `851b7136b5642360481b9896b154745bb8bee06adcc0017058cd964add396aee`.
- Exact source commit: `2f10c719690063cf2546e16fb21dadefd2610f6b`, pushed to `origin/master`.
- Source fingerprint: `fe6b4e76630498dd05b2b585cdf36de4beafa517c182bf0de35bcb6a423b506a`.
- Built `dist/cli.js`: `181437d0d3ff7711fb2c2ff59f268c90c821cf48b45290b82daaabe122dfaac6`.
- MAP SHA-256: `e5e0e0183cff1d3f37074775709fb32cee52ae68773756702354e1835a74fe7a`; routing policy: `routing-v5`.
- Dependency hashes: `package.json` `9b0e5e14d406e4509f82e521c589fec745f6d06fbbe8e4bdbda1d5f0211f9b98`; `package-lock.json` `bf41fadea55441e1d4d3c65472293cebb642e2fd86405e003ac7a0218575bf5a`.
- Exact runtime dependencies remain `better-sqlite3@13.0.3`, `@dagrejs/graphlib@4.0.5`, `ajv@8.20.0`, and `canonicalize@4.0.0`.
- Production `mcp` and `worker` entrypoints remain quarantined. The persistent unit is masked and inactive.

## Architecture verdict

`PASS`. STG-02 adds one compatibility boundary for existing state layouts. It opens only existing regular files in read-only mode, accepts exact state/history profiles `3/2` and `4/2`, checks schema and index metadata, and keeps graph execution disabled at compile time. The runtime cannot claim queue work, launch providers, or serve MCP.

The compatibility process produces an observation, not a self-issued deployment receipt. The external receipt binds the exact source commit and build hash to two systemd invocation identities, independent state inspection, and unchanged physical database/WAL/SHM hashes. Historical production schemas are admitted through explicit exact profiles rather than fuzzy matching.

## Gates and review topology

- Focused compatibility and legacy-contract gate: `7/7` files and `86/86` tests `PASS`.
- Typecheck, production build, and diff check: `PASS`.
- Repository gate: `68/68` files and `1550/1550` tests `PASS` in `743.82 s`.
- Production preflight, first open, restart, and second open: `PASS`.
- Codex auditor and Codex critic: semantic `PASS` on the exact source fingerprint.
- Grok auditor and critic: `optional_unavailable`; fixed cap `40/40` prevented new launches.
- Claude auditor and critic: `optional_unavailable`; fixed cap `40/40` prevented new launches.
- No optional receipt was synthesized. Ambiguous launched attempts: `0`.
- Reconciliation state: no STG-02 review attempt requires reconciliation; existing legacy reconciliation rows were neither rewritten nor reclassified by the read-only runtime.
- Duplicate-owner scan: `/root` alone owned final source and evidence mutations; `/root/activation_surface` and `/root/release_audit` were read-only reviewers.
- Architect-auditor verdict: `PASS` from read-only reviewer `/root/release_audit` on this corrected packet.

## Deployment evidence

- Transient unit: `agent-collab-compatibility-r2.service`; current state at `2026-09-01T07:58:46+08:00` was `active/running`.
- First invocation: PID `343583`, invocation `c6f68ca6f72c48c0b311690af7625432`.
- Restart invocation: PID `349790`, invocation `251a0c0c797c4353b8bf89c5e99ec4e3`.
- Runtime mode: `read_only`; graph execution, queue claims, provider launches, and MCP serving are disabled.
- State/history schema pair: `3/2`; integrity and foreign-key checks returned `ok`.
- Database, WAL, and SHM SHA-256 values match before the first open and after restart verification.

## Code surface delta

- Files: `1` added, `3` modified, `0` removed.
- Total stage source and tests: `+826/-33`, net `+793` lines.
- Product code: `+356/-33`, net `+323` lines.
- Tests: `+470/-0`, net `+470` lines.
- The product increase provides the new deployed compatibility capability; it does not add a scheduler, graph executor, or alternate service path.

## Progress estimates

- Active recovery/state/policy goal (deployed compatibility runtime): previous `0%`, current `100%`, delta `+100 pp`.
- Broader autonomous-Geek goal (production autonomous graph-runtime maturity): previous approximately `10%`, current approximately `18%`, delta `+8 pp`.
- Frozen implementation plan: previous `2/13 = 15.38%`, current `3/13 = 23.08%`, delta `+7.70 pp`.

## Documentation, C4, publication, and skipped checks

- Contract hash: `docs/hybrid-flow-v1/CONTRACTS.md` `2f223433e67874906c1aee503c18513c41e02f21cfcd34551245c4b0ee341d32`.
- MCP schema hash: `docs/hybrid-flow-v1/MCP_FLOW_V1_SCHEMAS.json` `22700454d3a6a34ea76b2bd8d0b748bd08d043227526aedb66a629585e6dae23`.
- State-v4 DDL hash: `docs/hybrid-flow-v1/STATE_V4_SCHEMA.sql` `43ae43d139ac44f25d2132439600a5405c1082a8278aca60cffeab5e479ead8b`.
- Eval hashes: contract `561183ec6181e4d45e468a9b749ffc4f6791eebb9cce6d89d923bdf9bb5a6edd`; runner `6ebdec0a21e4ee7d7e638cb936a95cf92f77662d35392cc69a12611ca3452dc3`.
- C4 hash: `repo-c4.json` `d4008cab2471456f5c3bf2049473ddf3565a6927b798f6b6bd5793cfa0e5a681`; deployed component topology did not change, so regeneration was skipped.
- Publish receipt: local HEAD and advertised `origin/master` both equal source commit `2f10c719690063cf2546e16fb21dadefd2610f6b`.
- Skipped checks: no new live Grok/Claude review was admitted because the immutable certification cap is `40/40`; no performance/load run is required for a read-only compatibility boundary; no C4 regeneration is required because the deployed topology is unchanged.

## Residual work

STG-02 does not authorize graph execution or restore the linear production service. Stages `STG-03` through `STG-12` remain open. STG-03 owns the guarded backup, additive v4 DDL, restore journal, graph stores, and import of the pre-v4 evidence chain.
