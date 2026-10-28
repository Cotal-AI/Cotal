---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/seat": minor
---

Install the Linux machine daemon as a systemd user service, and let a restarted daemon come back by itself.

`cotal daemon install` writes one systemd user unit, enables linger for the invoking user and starts it. The unit starts at login and restarts the daemon when it dies. `cotal daemon uninstall` stops it, disables autostart and removes the unit it recorded. Both take `--dry-run`, and a linger that cannot be enabled fails the install rather than leaving a service that stops at logout.

Both daemon forms now hold one kernel `flock` lifetime lock, the default daemon's at `<COTAL_HOME>/daemon/daemon.lock`. The kernel releases it when the holder dies, so a start knows its predecessor is gone without judging a recorded pid. The lock record names the socket its holder published by device and inode, and a start removes that socket and no other: a socket the record does not name, or one that appears after a clean shutdown, is refused and left in place. A crashed daemon no longer needs an operator to remove its socket before it can start again.

A service connection the space accepted is recorded per space, and a starting daemon connects every space it holds a record for, so the connections a daemon held before a crash come back with nothing to run. `service-disconnect` removes that record, so an explicit disconnect outlives a restart.

`@cotal-ai/seat` exports `flockExclusiveNb`, an exclusive non-blocking `flock(2)` added to the Linux native helper it already ships. `@cotal-ai/cli` exports the owned systemd user-unit primitives the daemon's install reuses, so there is one mechanism for writing and registering this CLI's units.
