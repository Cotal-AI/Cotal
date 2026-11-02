---
"@cotal-ai/core": patch
---

Freeze lazy service contract tables and their input/output pairs so callers cannot replace a command's validators. This also makes the exported registry contract table immutable. Commands still compile only on first access.
