---
"@cotal-ai/connector-jcode": patch
---

A Jcode seat that ends on a second private Harness disconnect, or on a recovery that fails, now names the Harness error its last failed turn reported on that final connector line as `last turn error: <message>`, when no turn has succeeded since. A turn the TUI owns counts both ways: its error is kept, and its success clears it. On a failed recovery the line reads `private Harness connection closed and recovery failed; last turn error: <message>; recovery error: <message>`, with the turn error first because the manager keeps only the first 240 characters of the line. The manager's `seat reaped:` line carries only the seat's last connector line, so a seat that died after a provider error used to be reaped with `private Harness connection closed after its one recovery attempt` alone, and finding the error meant reading the seat's private connector log.
