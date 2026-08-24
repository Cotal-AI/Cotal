---
"@cotal-ai/connector-jcode": patch
---

The jcode connector now proves its private Jcode tree is stopped before it returns, on both the
graceful stop and the startup-failure path. The SDK's managed stop keys the daemon off a
`servers.json` entry that must match the alias socket path verbatim, so a canonicalized entry or a
wiped registry was a silent no-op that orphaned the setsid `jcode serve` daemon and its MCP child
past the seat's death. The connector now launches the instance with a first-hand process handle,
reads the PIDs the private home itself records, and tears them down with a bounded SIGTERM,
exact-PID SIGKILL escalation, and liveness verification — throwing (and exiting non-zero) rather
than reporting a clean stop when a recorded process survives. It never signals by name, so
teardown can only reach the seat's own tree.
