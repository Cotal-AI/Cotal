---
"@cotal-ai/cli": patch
---

`cotal send` refuses an empty `--to`, `--channel` or `--role` value for the flag that was given, with a remedy that keeps that flag. It used to say to choose one body and suggest `-t <agent>` whatever flag was used.
