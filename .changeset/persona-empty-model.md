---
"@cotal-ai/cli": patch
---

`persona create` and `personas new` now refuse an empty `--model` with `USAGE_INVALID` naming
`--model`, instead of `SCHEMA_INVALID` "invalid persona fields". Any other field the writer refuses
is named in that refusal too.
