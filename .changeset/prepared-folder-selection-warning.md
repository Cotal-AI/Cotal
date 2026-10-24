---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A space prepared in a project folder and not started yet counts as that folder's space: a command run there with another space selected targets the prepared space, as it targets a registered one, so a `send` there before the first `up` no longer lands in the selected space unannounced.
