---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal history --since <n>` refuses a bare number past the chat stream's newest sequence, which names no message, with that sequence and how to write a date, so `--since 2026` no longer reads as an empty window. `chatRetention` also returns the stream's newest sequence.
