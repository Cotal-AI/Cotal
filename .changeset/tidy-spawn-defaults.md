---
"@cotal-ai/cli": patch
---

Keep detached spawn requests compatible with managers from before caller defaults were added. The
CLI now omits `defaultAgent` when an explicit `--agent` already wins or no caller default is set,
while preserving a non-empty caller default as a separate field so persona pins still outrank it.
