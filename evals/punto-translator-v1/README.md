# Punto/Translator paired corpus v1

This corpus compares Grok 4.6 and GPT-5.6 Sol on the same local coding work.
It is designed for sealed Git snapshots; the source checkouts are read-only
inputs and must never be used as attempt workspaces.

The eight tasks cover refactoring, reliability, bug fixing, and optimization in
both repositories. `TR-REL-01` starts from a pinned historical regression.
`TR-BUG-01` applies a small mutation only inside each sealed attempt copy.

`corpus.json` is the human-auditable source of task metadata. `suite.json` is a
strict, hash-locked manifest generated and verified by `agent-collab-eval`.
Oracle sources are hash-locked with the corpus but are copied only into the
run state's private evaluator directory. They, the identity maps, and prior
results are outside every candidate workspace and are not mounted into an
agent container.

The pilot contains `PUNTO-BUG-03` and `TR-BUG-01` at medium effort. It checks
the harness only and cannot change routing. The full study is designed for all
tasks, medium/high/xhigh effort, and four repetitions per case for exact AB/BA
balance. Six cases intentionally remain `runnable:false`; the CLI refuses a
full launch until their executable oracles exist.
