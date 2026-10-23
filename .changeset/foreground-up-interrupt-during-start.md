---
"@cotal-ai/cli": patch
---

Ctrl-C or SIGTERM on a foreground `cotal up` while the controller stack is still starting now stops
what was started. The start settles first, then the same guarded whole-stack stop as bare
`cotal down` runs, and the command exits 130 or 143. Before, the interrupt ended the command at
once with no output and left the broker, delivery and manager running.
