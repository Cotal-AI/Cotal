---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`config`, `config get` and `status` now warn with `PREFERENCE_INVALID` when a variable such as
`COTAL_DETACH_KEY`, `COTAL_DEFAULT_AGENT` or `COTAL_DEFAULT_PERSONA` holds a value `config set`
refuses, naming the variable and the reason. The variable still wins.
