---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal history --follow` now ends on its own when its credential can no longer connect, because it expired or because the broker rejects it, as after `reset space`. It ends with the refusal a one-shot command with that credential gets, `AUTH_REQUIRED` or `PERMISSION_DENIED` with its Next, and with `--json` it writes that `error` record and then its `end` record. Before, it printed the raw broker text and "re-establishing" and then waited forever. A lost connection is now one line, or one `TARGET_UNAVAILABLE` error record, while the follow re-establishes it, so a follow still outlives a broker restart. A credential past its own expiry is refused before any dial, since a broker still takes it during its last second.
