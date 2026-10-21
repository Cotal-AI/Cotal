---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
---

`cotal history [<channel>]` reads the newest retained messages in the selected space within the identity's read grant, newest last. `--limit` bounds the read (default 50, at most 1000); `--since` (a time, an age or a stream sequence), `--from` and `--grep` filter that window, and `--dms` adds DM history for an identity that may read it. The result names the chat stream's per-sender retention limit and each sender at it, so a short history is never shown as complete, and each channel's replay policy for new members. `--follow` keeps listening; with `--json` it writes one stream record per line, a snapshot, then one event per message, a gap after a reconnect, and an end record. A channel the identity may not read is refused with `PERMISSION_DENIED`, and a part that could not be read makes the run `partial` (exit 4). `history clear` purges the whole selected space after a confirmation, or with `--yes` in a script. Extra channel names and read filters are refused before a purge; `--dms` remains an explicit extension.

`CotalEndpoint.multiChannelHistory` now also returns each message's stream sequence, `chatRetention()` reports the chat stream's per-sender and age limits with each sender's retained count per channel, and `channelReplayPolicy(channel)` reads a channel's effective replay policy from the registry.

`--since` rejects ages outside the supported date range and sequences that cannot be represented without rounding, before connecting. They are usage errors, not unknown outcomes or silently rounded cursors.

`CotalEndpoint.channelHistoryPage` reads a newest window through a lifecycle-pinned, single-channel CHAT consumer. Native user-auth history uses that grant without enrolling the human CLI actor in delivery or publishing an ACL mirror. Concurrent readers wait for broker cleanup within bounded read budgets and never delete the shared consumer by name.

A connected history read that times out or is cut short reports `OPERATION_FAILED` (exit 5) with its target, not an unknown mutation outcome. Permission and usage refusals keep their existing codes.
