---
"@cotal-ai/core": patch
---

Readers now drop a presence row whose `card.role`, `activity` or `attention` is present and not a string, or whose `condition` is present and is not an object with a string `code` (`null`, a bare string and an object with no `code` included), and report it on the recoverable diagnostic path. A peer could previously put an object such as `{"toString":null,"valueOf":null}` in its own condition code or activity and make every other reader's `cotal_roster` fail with `Cannot convert object to primitive value` while that row was live.
