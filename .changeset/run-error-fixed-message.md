---
"@cotal-ai/connector-core": minor
---

Publish every `RUN_ERROR` on the events plane with the fixed message `run failed` and no `code` or `rawEvent`. The error text and error kind a harness reports are upstream values that can echo prompts, peer messages or tool output, and `events.<owner>.<actor>` has a different read ACL from where that text was read. Codex, Claude Code, OpenCode, jcode and pi all publish through this shared fence. An event write-ahead log frame frozen before this release whose `RUN_ERROR` has any other shape halts the emitter with `egress-run-error` on recovery instead of being republished. This is a breaking change for events-channel readers that used the message or code; see the 0.59.0 section of `docs/UPGRADING.md` for settling pending frames before the upgrade.
