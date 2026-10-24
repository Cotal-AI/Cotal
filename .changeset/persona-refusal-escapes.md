---
"@cotal-ai/cli": patch
---

`persona create` no longer writes a flag value's terminal escapes back to the terminal when it
refuses it. A `--role` or `--model` with control characters is refused by that rule first, and the
`--role`, `--subscribe`, `--allow-subscribe` and `--allow-publish` refusals quote the value with its
control characters escaped. A value could retitle or clear the terminal before.
