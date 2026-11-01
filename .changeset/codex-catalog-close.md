---
"@cotal-ai/connector-codex": patch
---

The Codex model catalog no longer rejects a valid `model/list` reply from an app-server that answers and exits at once; the lister now waits for stdout to close before treating the exit as unanswered.
