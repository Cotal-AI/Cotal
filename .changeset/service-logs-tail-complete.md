---
"@cotal-ai/cli": patch
---

`cotal service logs` returns a complete result, exit 0, when its tail holds every line asked for. A
log longer than its 1 MiB bounded read made every tail partial, exit 4, so a script could not tell
the tail it asked for from a failure. A tail is now partial only when that read holds fewer lines
than requested.
