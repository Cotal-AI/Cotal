---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal backup create` no longer refuses a cut because the presence bucket is missing. The bucket is memory-backed, so it does not survive the broker stop that makes the cut. Backup now accepts that stream as absent from the stopped store and still requires every other stream exactly. Restore still requires presence after it recreates the space's infrastructure.
