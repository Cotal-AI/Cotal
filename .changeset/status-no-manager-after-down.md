---
"@cotal-ai/cli": patch
---

Keep `result.folder.noManager` true in `cotal status --json` after `cotal down` stops a controller stack that was started with `--no-manager`.
