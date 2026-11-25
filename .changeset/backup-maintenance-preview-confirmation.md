---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Reject combining `--dry-run` and `--yes` on `backup recover` and `backup cleanup-fallback` before looking up the attempt.
