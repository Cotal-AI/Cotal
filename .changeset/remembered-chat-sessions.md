---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Core can read the direct messages to and from named principals, and tells a refused read apart from a space with none.

`CotalEndpoint.dmHistoryOf(principals)` filters on the broker and answers `{ state: "denied" }` when the credential may not read direct messages, while `dmHistory` keeps its empty list. The workspace keeps one private record per chat session the terminal app opens, the newest 20 per space and no credential, so the app can count those sessions as yours and show their direct messages after a restart. `cotal space forget` removes a space's records and counts them in its receipt as `removedChatSessions`.
