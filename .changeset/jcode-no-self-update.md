---
"@cotal-ai/connector-jcode": patch
---

connector-jcode: a managed seat no longer updates its own binary

Jcode's background updater restarts the process tree when it lands a release. That restart
SIGTERMs the seat's TUI, which is the only connection the Jcode server counts as a client, and
nothing re-attaches afterwards — so the server's idle reaper shuts the whole seat down five
minutes later, mid-turn, with `exit code 1, signal 0` and no signal from the manager. The seat's
version is now the operator's choice at spawn time and cannot change under a running agent.
