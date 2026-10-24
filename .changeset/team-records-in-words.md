---
"@cotal-ai/cli": patch
---

The team reports name each record's kind, recorded state, next action and auth mode in words, such as
`boot returned`, `inspect the stack` and `static auth`. `team show` printed the raw values, such as
`broker-boot-returned`, and the auth mode read `auth`, `static` or `static-auth` depending on the
report. The JSON results keep the recorded values.
