---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal down` no longer fails with `ENOENT` when a component removes its own process record while the command runs. The record readers in `down`, the manager, delivery and auth-service helpers, and `cotal service status` checked that a pidfile existed and then read it, so a record removed between the two calls threw: `cotal down manager` printed `✗ ENOENT` and `✗ not cleanly stopped` and exited 1, and `cotal down nats` aborted before stopping the broker. Each reader now reads the record once through the new `readPidfile` helper in `@cotal-ai/workspace`. A record that is gone takes the no-record path, and any other read error still throws.
