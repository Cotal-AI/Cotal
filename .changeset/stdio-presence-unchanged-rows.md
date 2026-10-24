---
"@cotal-ai/cli": patch
---

Every `attention` and `channelMode` change in a `chat --stdio` session sent peers a presence `updated` record whose row was unchanged, since the row shows neither. A presence change that leaves the row as it was now writes no record, and `updated` means a field the row shows changed.
