# PUNTO-REF-01: configuration parsing ownership

Refactor the duplicated configuration text parsing used by the daemon and tray
settings code into one owned, testable component. Preserve accepted keys,
defaults, comments, whitespace behavior, numeric locale behavior, and the
serialized configuration format. Add characterization tests before changing
the implementation. Remove the superseded duplicate parsing path; do not keep
two implementations or add a framework.

Return a concise implementation note and leave the working tree with the code
and tests. Do not install packages, use the network, edit system state, or
modify files outside this repository copy.
