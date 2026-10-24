---
"@cotal-ai/cli": patch
---

A `nats-server` on PATH that answered `--version` replaced the bundled broker whatever version it reported, and nothing named which one ran: an old one failed later with a broker that exited before readiness. `cotal up` and `cotal setup` now refuse a `nats-server` on PATH older than 2.12, or one that reports no version, with `DEPENDENCY_UNAVAILABLE` naming its path and version before the broker starts. The `up` receipt names the broker executable, where it was found and its version (`result.brokerExecutable` in `--json`), `status` names the one Cotal will run, and `service status` names the file a running instance executes.
