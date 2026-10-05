---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
---

Design record for carrying a detached `cotal spawn --resume <id> --detach --on <instance>` session to a manager on another host (`docs/design/resume-transfer.md`). The transcript moves through a per-space JetStream Object Store bucket for the target manager instance, in chunks sized to the broker's `max_payload`, with a chunk chain that resumes an interrupted upload and a content-addressed staging copy that makes a repeat move no bytes. The manager gains the operator-only `transcript-receive` command and `spawn` gains a one-time `resumeClaim`. The carried transcript is placed in a seat-private Claude config home that authenticates with an environment credential, and `cotal ps` and `cotal attach` show where a seat was resumed from. The implementation follows this record in the same change.
