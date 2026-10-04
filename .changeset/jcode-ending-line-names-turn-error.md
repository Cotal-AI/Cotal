---
"@cotal-ai/connector-jcode": patch
---

A Jcode seat that ends on a second private Harness disconnect, or on a recovery that fails, now names the Harness error its last failed turn reported on that final connector line as `last turn error: <message>`, when no turn has succeeded since. The manager's `seat reaped:` line carries only the seat's last connector line, so a seat that died after a provider error used to be reaped with `private Harness connection closed after its one recovery attempt` alone, and finding the error meant reading the seat's private connector log.
