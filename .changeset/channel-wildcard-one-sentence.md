---
"@cotal-ai/cli": patch
---

A channel name holding `*` or `>`, such as `gen*`, now gets `name one concrete channel, without wildcards` from `cotal send -c`, `cotal chat <channel>` and every `cotal chat --stdio` request that names a channel. Before, a `*` inside a segment got the channel grammar's rule, which lists `'*'` and `'>'` as allowed segments, and a stdio request gave a third wording. A stdio channel refusal now carries the same sentence as `cotal send -c`, without a field prefix.
