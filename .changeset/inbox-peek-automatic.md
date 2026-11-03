---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-codex": patch
"@cotal-ai/connector-opencode": patch
---

Let `cotal_inbox` with `peek` show the connector-managed automatic messages still queued in Codex, Jcode and OpenCode seats, without clearing anything. A DM that arrives during a turn the operator started, or a plain channel post during any turn, can now be read before that turn ends. The connector still delivers and clears it at the end of the turn.
