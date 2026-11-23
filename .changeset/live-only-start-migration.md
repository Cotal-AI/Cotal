---
"@cotal-ai/cli": patch
---

The removed `cotal start` command now recommends a foreground spawn when you pass `--live-only`. It explains that managers cannot use the flag and avoids printing a retry with conflicting launch options.
