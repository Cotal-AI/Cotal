---
"@cotal-ai/cli": patch
---

Refuse conflicting up output and manager-only options as classified usage errors before preparing a project or taking a maintenance lock. Do not leave a new control directory or stale lock when --json/--plain conflict or --no-manager is paired with --runtime or --max-sessions.
