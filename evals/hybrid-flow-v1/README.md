# Hybrid flow v1 locked evaluation

This suite is frozen before graph-runtime implementation. It runs against built
artifacts and records missing capabilities as `unsupported`, never as a fast
success. Baseline and candidate must use byte-identical `eval-contract.json`
and `run-evals.mjs` files.

The deterministic score measures orchestration correctness, not model answer
quality. Paid/live model quality remains a separate paired canary requiring an
explicit provider and cost limit.

Run:

```bash
npm run build
node evals/hybrid-flow-v1/run-evals.mjs --label baseline --output .artifacts/hybrid-flow-v1/baseline.json
```
