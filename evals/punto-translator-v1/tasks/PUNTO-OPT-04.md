# PUNTO-OPT-04: edit-distance hot path

Optimize `damerau_levenshtein_distance` without changing its observable result.
Reduce auxiliary memory from the full two-dimensional matrix and avoid
unnecessary allocations in the hot loop. First add semantic equivalence tests
covering empty, equal, insertion, deletion, substitution, adjacent
transposition, mixed lengths, and deterministic randomized inputs. Add a local
benchmark that compares the same workload before and after without asserting a
machine-specific absolute time.

Do not weaken correctness for speed, install packages, use the network, or
modify files outside this repository copy.
