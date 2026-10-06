---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Ctrl-C on a foreground `cotal up`, and a broker that exits under it, now stop the delivery daemon with the same stop `cotal down delivery` uses. Before, that teardown took no stop reservation and never escalated past SIGTERM: a concurrent `cotal down delivery` could not see the stop in progress, and a daemon that did not exit on SIGTERM survived the teardown while `up` went on to stop the broker. The teardown now holds the reservation, sends SIGKILL after the 15-second grace, and removes the daemon's credential only once its death is confirmed. If the broker exits while the Ctrl-C teardown is running, `up` waits for that teardown to finish before it exits. `cotal down delivery` now clears a record whose pid belongs to another program without signalling it, as the `up` teardown already did. A local process descriptor can carry `isOwnCommand` for that check; an installed extension's descriptor is cached as data and is refused if it declares one.
