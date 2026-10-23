---
"@cotal-ai/cli": patch
---

`cotal send -c` to a channel with no registry entry now says whether the channel already has messages or this message starts it, and lists the space's registered channels, so a mistyped channel name no longer gets the same warning as a post to a channel in use. The `--json` warning carries the same facts as `earlierMessages` and `registered`. The count is read as `cotal history` lists channels; where it cannot be read, the warning says it was not checked.
