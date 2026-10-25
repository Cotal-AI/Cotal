---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Reject extra positional arguments before any cleanup runs. Previously `clean history <channel>`
ignored the channel name and purged all channel history, and extra words did not prevent local
store deletion. Quote an explicit store directory in the dry-run force command so paths with
spaces or shell characters remain one argument. Valid cleanup scope and missing-directory no-ops
are unchanged.
