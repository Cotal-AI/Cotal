---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

`cotal_roster` and `cotal endpoints` now print a peer's instance id where its name does not reach it. Both used to count names on their own and mark every row whose name repeated, which disagreed with `resolvePeer`: a session's `cotal_dm` to a name it shares with one other peer reaches that peer, and a live peer is reached over an offline one of the same name, yet both rows carried an id as if the name were ambiguous. Core now exports `unaddressableByName`, which asks `resolvePeer` for each row, and both renderers use it with their existing suffixes. A session's own row no longer carries its id, since a session never addresses itself.
