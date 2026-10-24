---
"@cotal-ai/cli": patch
---

`service stop --dry-run` now names what the stop would signal: the process group with its member
count, or the process alone, and the grace period before `SIGKILL`, and says a descendant that left
the group, such as one started with `setsid`, is not signalled. `--json` carries it as `stopSignal`.
A `service start` refused because something already answers its HTTP readiness address now names
each process of this account that listens there by PID and program name, as the
`SERVICE_ADDRESS_HELD` warning does, and its Next says to stop that process. The start still does
not signal it.
