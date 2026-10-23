---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A managed verb such as `cotal ps`, `stop`, `attach` or `spawn` that cannot choose between several of your live managers now shows the choice. It used to refuse with only the instance ids inside one sentence. It now lists each manager on its own row with its instance id, host, activity (which names its runtime) and the time its process started, and its Next gives your own command again with `--on <instanceId>` for each one. The code and the exit code stay as they were, and `--json` carries the rows under `error.cause.detail.managers`.
