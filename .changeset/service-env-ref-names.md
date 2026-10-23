---
"@cotal-ai/cli": patch
---

`cotal service start` or `restart` for a definition whose `envRefs` read a variable the shell does not set refused `DEPENDENCY_UNAVAILABLE` with "a selected host environment reference is unavailable" and named no variable, and `service show` did not list the references at all. The refusal now names each missing variable and the child variable it feeds, never a value, with a Next that says to set it, and `service show` lists the references as `REVIEWS_TOKEN from MY_TOKEN`.
