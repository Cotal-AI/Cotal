---
"@cotal-ai/core": patch
---

A peer's `name/role` roster label used as a target is now refused with the peer's bare name in the message, everywhere a peer is resolved by name: `cotal_dm`, `cotal send dm`, `cotal deliver pending`, the console and `join`'s `/dm`. It used to read as an unknown peer. The label is not resolved as an address because `/` stays reserved for `owner/name` handles.
