# TR-REF-01: SourceCommit finalization ownership

Remove the duplicated state-transition logic between `SourceCommit.finalize`
and `SourceCommit.finalize_async`. Preserve sync and async public APIs, privacy
behavior, exception mapping, cancellation semantics, exactly-once translation,
and concurrency behavior. Characterize both paths first and leave one clear
owner for shared validation, state entry, result validation, and commit.

Run only deterministic local tests. Do not install packages, use provider
APIs, use the network, or modify files outside this repository copy.
