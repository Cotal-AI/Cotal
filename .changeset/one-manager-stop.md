---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Every manager stop the CLI makes now runs the stop `cotal down` runs. Ctrl-C on a foreground `cotal up`, the teardown after its broker exits, the leftover-manager stop before `cotal up -f` and the delivery cutover preflight used a second stop that took no stop reservation, skipped the spare-capability check and gave up after 2s, leaving a wedged manager running with its record kept. They now hold the reservation, so a stop while another `cotal down` is stopping the manager is refused, verify the spare capability before signalling, and send `SIGKILL` to a manager still running 15s after `SIGTERM`. Ctrl-C stops the manager first and, when that stop fails, signals nothing else and leaves the stack running. A pre-pin manager record whose pid now runs a process that is not a manager is removed without a signal on every path, `cotal down` included. The workspace exports `stopReservationPath`, the one spelling of a pidfile's stop reservation.
