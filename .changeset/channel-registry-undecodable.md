---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal channel` now reports a channel registry entry that does not decode, such as a raw put that is not JSON, as a warning with its decode error. It used to leave the entry out of the list, and `show` said `no saved entry` for it. `readChannelRegistry` returns such entries in `undecodable`. `cotal up` no longer writes its default delivery class over space defaults that do not decode: `ensureDefaultDeliveryClass` throws `UndecodableChannelDefaults`, and `up` warns and leaves the entry for the operator to replace.
