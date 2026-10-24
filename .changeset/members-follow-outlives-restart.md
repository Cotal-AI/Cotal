---
"@cotal-ai/cli": patch
---

`cotal channel members --follow` now outlives a broker restart. A lost connection is one `TARGET_UNAVAILABLE` error record, or one line, while the follow reads the feed again, and once it answers the follow writes a `gap` record and the current census. Before, a read that failed during the restart ended the follow with `OPERATION_PARTIAL`, exit 4. A credential that can no longer connect, because it expired or the broker rejects it, ends the follow with the refusal a one-shot command with that credential gets, as `cotal history --follow` does, and with `--json` that `error` record and then `end` with reason `refused`.
