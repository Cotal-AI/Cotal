---
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

Add anonymous, opt-out usage telemetry to the `cotal` CLI. Each command sends one small event as it exits (command name, outcome, exit code, duration, version, OS, architecture, Node major, CI flag; at the default `regular` level also the registered subcommand, flag names, the typed error code, whether stdout is a terminal, the shell and terminal program names, plus one install summary per UTC day). It never sends arguments, flag values, paths, mesh, space, agent or user names, environment values, error text or message content. `cotal telemetry` shows the level in force, its source, the random install id and the intake URL; `cotal telemetry off|minimal|regular` sets it. `DO_NOT_TRACK=1` and `COTAL_TELEMETRY_DISABLED=1` force it off, `COTAL_TELEMETRY` names a level, and `COTAL_TELEMETRY_URL` points a self-hosted intake. A one-time notice prints on the first interactive run. The settings live in `<home>/telemetry.json`; `@cotal-ai/workspace` gains its reader and writers.
