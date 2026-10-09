---
"@cotal-ai/cli": patch
---

Foreground `cotal up` and `cotal up --detach` now run the steps between spawning nats-server and serving it through one sequence: readiness, the broker version read, the server name check of a resumed or restored listener, and `.cotal/nats.pid`. A foreground `up` whose broker is below the 2.12 floor used to exit with the broker still running and `.cotal/nats.pid` recorded but no mesh entry. It now stops the broker and removes the pidfile, as `--detach` did. A foreground resume after `cotal down --preserve-state` now refuses a spawned listener that reports a foreign NATS server name, which only `--detach` checked before. A foreground `up` whose broker never answers now removes `.cotal/nats.pid` itself, and a fresh foreground boot writes the pidfile only after the version check.
