---
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

When a registered manager does not answer, as after a crash, `input` and `stop` refuse
`TARGET_UNAVAILABLE` because nothing was sent, instead of reporting an unconfirmed outcome. That
refusal, and the one `cotal run`'s hosted verbs give, now leads with "the manager registered for this
space did not answer".
