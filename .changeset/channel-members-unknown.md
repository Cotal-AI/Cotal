---
"@cotal-ai/cli": patch
---

`cotal channel members` refuses a name the space does not have with `TARGET_NOT_FOUND`, as `channel remove` does, when the feed observes no member for it, so a typo or a name in another case no longer reads as an empty channel. `--follow` shows the census again only when it changes, and its view no longer offers the follow it is running.
