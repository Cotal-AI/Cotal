---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Channel history has no age limit by default again. A space keeps a channel post until its sender has posted 1000 newer ones on that channel, as it did up to 0.133.13, and an age applies only when an operator sets one with `cotal history limit`.

An upgrade no longer moves or deletes posts. 0.134.0 moved every existing space to a 30-day limit at its first `cotal up`, which deleted every channel post older than 30 days. That move is gone: `cotal up` changes no space's limit, and a space that 0.134.0 already moved keeps its 30-day limit until an operator changes it. `cotal up`, `team boot` and `setup --start` no longer report `CHAT_HISTORY_MIGRATED`. `@cotal-ai/core` no longer exports `LEGACY_CHAT_HISTORY`, `isLegacyChatHistory` or `reconcileChatHistory`, and `setupSpaceStreams` returns nothing; it still refuses a chat stream whose settings other than the limit are not canonical.
