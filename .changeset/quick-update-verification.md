---
"@cotal-ai/cli": patch
---

Reduce self-update registry verification time and show progress before long update steps.

Read independent package metadata in bounded batches and ask npm to verify several archives per invocation. Keep all package, version, dependency, recovery and lock checks, with a private cache for each command.
