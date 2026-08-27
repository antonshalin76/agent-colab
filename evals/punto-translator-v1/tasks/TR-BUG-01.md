# TR-BUG-01: terminal utterance identity cleanup

A seeded regression leaves terminal utterance identity state active after the
utterance is finalized. Find the leak, fix it at the owning terminal transition,
and add a regression that repeatedly completes distinct utterances without
false active-capacity failures. Preserve terminal tombstones, sequence rules,
queue accounting, and duplicate-terminal rejection.

Use deterministic local tests. Do not install packages, use provider APIs, use
the network, or modify files outside this repository copy.
