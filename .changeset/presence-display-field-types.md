---
"@cotal-ai/core": patch
---

Readers now drop a presence row whose `card.role`, `activity`, `attention` or `condition.code` is present and not a string, and report it on the recoverable diagnostic path. A peer could previously put an object such as `{"toString":null,"valueOf":null}` in its own condition code or activity and make every other reader's `cotal_roster` fail with `Cannot convert object to primitive value` while that row was live.
