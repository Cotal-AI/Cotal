---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal channel` lists a registry key whose value does not decode, with the decode error, and `readChannelRegistry` returns those keys in `undecodable`. A single-key read still resolves such a value as unset, as an endpoint's registry watch does. A later write does not replace those bytes: `cotal up`, including one whose channel seed would write the key, and `cotal channel set` or `channel defaults`, refuse with `CONFLICT` and leave the key as it is. `channel remove` removes it. A defaults value that decodes but names no delivery class is still filled.
