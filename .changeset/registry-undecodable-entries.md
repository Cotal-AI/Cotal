---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

`cotal channel` names every channel registry entry that does not decode, with its decode error, instead of leaving it out without a word. `readChannelRegistry` returns those keys in a new `undecodable` list beside `defaults` and `channels`; the listing, `show` and `defaults` warn about the entries they read, and `show` no longer reports such a channel as having no saved entry. `cotal up` warns when the saved channel defaults do not decode and it replaces them with the profile's delivery class. `ensureDefaultDeliveryClass` now returns `{ wrote, replaced? }` instead of a boolean, where `replaced` is the decode error of the defaults it replaced.
