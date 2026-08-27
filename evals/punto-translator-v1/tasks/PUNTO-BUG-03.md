# PUNTO-BUG-03: strict IPC command grammar

Find and fix the IPC parser defect that accepts commands merely because they
share a valid prefix. Commands without arguments must match exactly after
trimming. Commands with arguments must use the required token boundary and
validate their argument grammar. Add regression tests for valid commands and
for misleading prefixes, suffixes, extra tokens, and whitespace.

Use TDD. Preserve the public response format and avoid unrelated refactoring.
Do not install packages, use the network, edit system state, or modify files
outside this repository copy.
