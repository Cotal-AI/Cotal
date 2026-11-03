---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/core": minor
---

An OpenCode agent name now has one launcher at a time. Two launches that overlapped both passed the server-record check, which runs before the version probe and the spawn, so both started a server on the agent's SQLite database. The launcher now first claims the name with core's advisory lock, `launch.lock` in the agent's directory, and holds it until it exits. A second launch is refused as already running, and a claim left by a launcher that died is reclaimed. `@cotal-ai/core` exports the lock as `@cotal-ai/core/advisory-lock`, so the bundled launcher can use it without the barrel.
