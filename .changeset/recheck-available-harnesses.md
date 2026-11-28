---
"cotal-ai": patch
"@cotal-ai/manager": patch
---

A running Manager now stops offering an agent application as soon as it is uninstalled, without restarting the background service. Every status read, model lookup, command listing, resume and launch verifies that an available connector's recorded executables still exist and still resolve on `PATH`. When one is missing, the connector row becomes `unavailable` with `<name> harness needs <bin> on PATH - not found`, launches are refused before reserving a name or capacity, and class `spawn` and `launch` subscriptions update when no available application remains.
