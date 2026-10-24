---
"@cotal-ai/cli": patch
---

The CLI reference says that a restore without `--store-dir` creates its store at `.cotal/nats` even
when the preserved store is elsewhere, that the preserved store stays where it is until
`backup cleanup-fallback` deletes it, and that `--store-dir` keeps the space on another disk.
