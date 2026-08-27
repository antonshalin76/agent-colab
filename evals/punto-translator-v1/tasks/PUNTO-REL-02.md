# PUNTO-REL-02: bounded IPC client handling and shutdown

Make the Unix-domain IPC server resilient to a client that connects and then
stalls before sending a complete request. A stalled or partial client must not
block other valid clients indefinitely, and server shutdown must remain
bounded. Preserve the existing protocol and socket ownership rules. Start with
deterministic tests for slow-client isolation, partial input, EOF, and shutdown;
then implement the smallest reliable fix.

Do not install packages, use the network, edit system state, or modify files
outside this repository copy.
