---
"@cotal-ai/connector-codex": patch
---

Call `child.kill("SIGKILL")` directly in `listCodexModels` and `AppServerDriver.stop` rather than wrapping it in an empty `try`/`catch`. `ChildProcess.kill` returns `false` on an already-exited or unspawned child and throws only for an invalid signal, so the empty handlers were dead code that swallowed signal errors.
