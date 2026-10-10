---
"@cotal-ai/core": patch
---

An anycast delivery now reaches `message` listeners with `toService` set to the role in its `svc` subject, and with any payload `to` or `channel` removed, as channel and DM deliveries already were. The payload's routing fields used to pass through unchecked, so a peer could publish to one role while the receiver saw another role, a DM addressed to it, or a channel post, for example in `cotal join` output and connector inbox frames.
