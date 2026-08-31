# Hybrid Flow v2 baseline/candidate comparison

Generated: 2026-08-31. This is the normative amendment to the original locked
eval. The v1 runner is preserved byte-for-byte; v2 fixes its invalid depth/root
fixture, false-pass assertions, global import masking, and source-string MCP
check.

Both runs used the same contract and runner:

- contract SHA-256: `2f7243d3ce16478fa5314a3ab5724201b9e2cc8b8dea4e0c2518ea65e290cf9b`;
- runner SHA-256: `56c53a0e373903907307c2feb9dc4c9f9b5790ddddeca865c392d4cac3d6380e`;
- baseline source: `d0f6cda738cf08ff851f14192ff48e636c1f0f17`;
- candidate: current working tree, built immediately before the run.

| Metric | Baseline | Candidate | Delta |
|---|---:|---:|---:|
| Functional cases passed | 0/12 | 12/12 | +12 cases |
| Verified completion rate | 0% | 100% | +100 pp |
| Failed cases | 1 | 0 | -1 |
| Unsupported cases | 11 | 0 | -11 |
| Pure graph 100 nodes/400 edges median | unsupported | 2.788 ms | new capability |
| Pure graph 100 nodes/400 edges p95 | unsupported | 4.922 ms | passes 50 ms gate |
| Read-only fan-out 3x40 ms median | 120.607 ms | 40.264 ms | -66.62%, 3.00x faster |
| Read-only fan-out 3x40 ms p95 | 120.755 ms | 40.384 ms | -66.56% |
| Legacy 100-run chain median | 32.613 ms | 32.772 ms | +0.49% |
| Legacy 100-run chain p95 | 41.521 ms | 40.539 ms | -2.36% |

The legacy differences are not treated as a proven performance change: they
come from 20 short local samples, while the median is effectively unchanged. A load-test
run with warm-up and confidence intervals is required before making a latency
claim about the legacy queue.

The 12 deterministic cases cover DAG validation, cycle rejection, fan-out,
all-success/all-terminal joins, conditional routing, unreachable-node skipping,
typed result fail-closed validation, session isolation, usage completeness, and
real MCP tool discovery for `collab_flow_validate`.

This suite measures orchestration correctness and local runtime speed. It does
not measure semantic model-answer accuracy, recall, hallucination rate, or the
quality contribution of Grok/Claude. No live provider call was made. Those
metrics require a separately authorized paired task corpus; current live-launch
capacity is exhausted and was not increased.

Evidence:

- `.artifacts/hybrid-flow-v2/baseline.json`;
- `.artifacts/hybrid-flow-v2/candidate.json`;
- `evals/hybrid-flow-v2/eval-contract.json`;
- `evals/hybrid-flow-v2/run-evals.mjs`.
