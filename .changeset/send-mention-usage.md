---
"@cotal-ai/cli": patch
---

`cotal send -t` or `-r` with `--mention` is refused as `USAGE_INVALID` (exit 1) with a remedy, since the parser can judge that combination, rather than `UNSUPPORTED` (exit 2).
