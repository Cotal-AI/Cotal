---
"@cotal-ai/orca": patch
---

The Orca runtime's status check and exit wait now find a seat's terminal by the same rule, so the manager no longer sees an exit wait report an agent gone while its status still reads running. A terminal whose PTY id `orca terminal list` no longer shows now reads as exited, and close leaves it alone, without asking `orca terminal show` about its old handle, which could name a different terminal. A `terminal show` that answers ok with no terminal is now an error everywhere, as the exit wait already treated it, instead of standing in for the caller's own terminal: status still reads running, while close and interrupt fail. The driver exports `isGoneCode`, the one test for the Orca error codes that mean a terminal is gone.
