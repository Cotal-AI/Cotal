---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/pi": minor
---

Connectors launch on the model and variant their launcher resolved. `LaunchOpts.model` and `LaunchOpts.variant` are now the launcher's resolved values (the flag, else the agent file's `model:` / `variant:`), and every connector renders them as given instead of reading the agent file again in `buildLaunch`. Before, a model the launcher did not resolve was taken from a later read of a file that could have changed since, so the seat could run a model the launcher never checked or recorded, and a supervised restart re-read it each time. The in-session config takes the model and variant from `COTAL_MODEL` / `COTAL_VARIANT` only, so the card and the orientation pin no longer report a model the seat was not launched on. The Hermes connector no longer falls back to `HERMES_MODEL` from the spawning process, including one `spawn.env` forwards; set the model with `--model` or the persona's `model:`. Code that calls `buildLaunch` directly must pass `model` and `variant` itself.
