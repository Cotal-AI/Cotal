---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal channel remove` no longer says a channel was removed when it had no saved entry, such as a mistyped name or one already removed. That run is now a `no-op`: the receipt reads `Nothing removed` with `Metadata: no saved entry`, and `result.removed` is `false`. With `--purge`, the channel's retained messages are still purged and the receipt says so. `deleteChannels` now returns the channels it removed, and `clearChannel` says whether it removed the channel's entry.
