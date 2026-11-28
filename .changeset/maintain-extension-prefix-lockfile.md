---
"@cotal-ai/cli": patch
---

Extension installs, updates, and removals now pass `--package-lock=true` for Cotal's managed extensions prefix so `package-lock.json` stays current when npm configuration sets `package-lock=false`, without changing the user's npm configuration.
