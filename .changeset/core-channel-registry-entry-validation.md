---
"@cotal-ai/core": patch
---

The channel registry readers now validate each entry the way the write path does. The endpoint's
registry watch, `readChannelConfig`, `readChannelDefaults` and `readChannelRegistry` decode through
one `decodeChannelEntry`, which refuses a value that is not a JSON object or fails
`validateChannelConfig` or `validateChannelDefaults`. A raw put of an unknown delivery class or of
`null` on the defaults key is now dropped with a `warning`, and its channel resolves to the default
policy, instead of being cached as is. The validators also reject a `replay` that is not a boolean
and a `description` or `instructions` that is not a string.
