---
"@cotal-ai/cli": patch
---

A live `event` record of `history --follow --json` no longer carries `"seq": null`. The live feed
carries no stream sequence, so the field is left out; the snapshot's items keep their sequence, and
`--since` with the last event's `ts` reads on from a follow.
