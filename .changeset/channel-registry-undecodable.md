---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal channel` now lists a registry key whose value does not decode, with the decode error, and leaves the key in the bucket. `readChannelRegistry` returns those keys in `undecodable`. A single-key read still resolves such a value as unset, as an endpoint's registry watch does. `cotal up` no longer replaces an undecodable defaults key with the space default: it refuses with `CONFLICT` and leaves the bytes as they are.
