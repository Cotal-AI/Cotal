---
"@cotal-ai/cli": patch
---

The `cotal chat` recipient picker (`:to #<channel>` in `--plain`, and typed text in the terminal view) now refuses a channel name holding `*` or `>` with `name one concrete channel, without wildcards`, the sentence `cotal send -c` gives. Before, `#team.*` got a picker-only wording and `#gen*` got the channel grammar's rule, which lists `'*'` and `'>'` as allowed segments.
