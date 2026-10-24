---
"@cotal-ai/cli": patch
---

`cotal clean restore-fallback` refused without `--discard-history` now prints its refusal and the
command to run without the whole `cotal clean` help under it, as `backup cleanup-fallback` does.
