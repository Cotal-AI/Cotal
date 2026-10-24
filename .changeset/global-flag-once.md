---
"@cotal-ai/cli": patch
---

`--no-color` and `--no-input` given twice, before or after the command word, are refused as the usage error any repeated flag gets, `Option '--no-color' cannot be repeated`, exit 1. They used to be accepted.
