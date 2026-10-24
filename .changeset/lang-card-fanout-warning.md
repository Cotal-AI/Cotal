---
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

The cotal-lang card and the CLI reference now say that `cotal run validate` warns about a `fanOut`
with no stable key (L3021) only for a list written in the call. A list held in a variable gets no
warning and the run refuses it when it reaches it, so its items need an `id` or the call a `key`.
