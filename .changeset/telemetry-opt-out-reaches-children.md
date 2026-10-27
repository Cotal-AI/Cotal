---
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
---

Usage telemetry follows the environment into the processes Cotal starts. `DO_NOT_TRACK`, `COTAL_TELEMETRY`, `COTAL_TELEMETRY_DISABLED`, `COTAL_TELEMETRY_URL` and `CI` now reach the agents a manager spawns and the services `cotal service start` launches. Before, both dropped them: a `cotal` command an agent or a service ran reported at the settings file's level to `https://cotal.ai`, even when the run that started it had opted out or pointed at a self-hosted intake, and it reported `ci: false` inside a CI job. The `ci` field is now `false` when `CI` is `0` or `false`, which is how a script says it is not a CI run. Before, any value counted as CI.
