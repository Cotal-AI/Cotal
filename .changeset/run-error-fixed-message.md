---
"@cotal-ai/connector-core": patch
---

Publish every `RUN_ERROR` on the events plane with the fixed message `run failed`, and keep its `code` only when it is a short identifier. The upstream error text a harness reports can echo prompts, peer messages or tool output, and `events.<owner>.<actor>` has a different read ACL from where that text was read. Codex, Claude Code, OpenCode, jcode and pi all publish through this shared fence.
