---
"@cotal-ai/cli": patch
---

A usage refusal under `--plain`, or under a locale that is not UTF-8, now prints the classified report that begins `Request refused`, then the command's help. It printed the `✗` mark under `--plain`, and the `!` warning mark under such a locale.
