---
"@cotal-ai/runtime": patch
---

`run start --local` refuses an `--admit-read` or `--admit-publish` entry that is not a channel or a
pattern, such as `a b`, with `USAGE_INVALID` naming it. It used to be admitted as the channel the
wire layer rewrote it to, `a_b`.
