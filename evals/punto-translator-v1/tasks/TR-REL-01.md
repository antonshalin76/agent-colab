# TR-REL-01: self-healing audio graph

The pinned revision can observe a degraded or failed virtual audio graph but
does not reliably restore it during runtime refresh and translation lifecycle
changes. Implement bounded self-healing that rechecks the graph, recreates
missing endpoints when required, updates runtime state, preserves audible
bypass while translation is stopped, and reports safe failures without
panicking. Add deterministic fake-graph and API lifecycle tests; do not require
live PulseAudio.

Do not install packages, use the network, edit system services, or modify files
outside this repository copy.
