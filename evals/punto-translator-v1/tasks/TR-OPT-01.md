# TR-OPT-01: deterministic PCM transform

Optimize `mock_transform_pcm` for large s16le buffers while preserving exact
sample-order semantics, input immutability, even-length validation, and bytes
output. Add property-style deterministic equivalence tests across edge sizes
and randomized samples, plus a repeatable local microbenchmark. Prefer a
standard-library operation with fewer temporary objects over custom loops.

Do not install packages, use provider APIs, use the network, or modify files
outside this repository copy.
