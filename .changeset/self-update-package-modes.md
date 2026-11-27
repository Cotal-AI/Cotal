---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Remove group and other write permissions from global npm `cotal-ai` package installations during `cotal update` and `cotal update --self`, including when the installed version is already current.
