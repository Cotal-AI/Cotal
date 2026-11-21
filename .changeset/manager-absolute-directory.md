---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The CLI tells you to pass an absolute path on the manager's host when `resolve-cwd` or `list-dir` rejects a relative path. It reports that the lookup did not run without showing the rejected path.
