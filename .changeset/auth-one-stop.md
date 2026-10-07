---
"@cotal-ai/cli": patch
---

Ctrl-C on a foreground `cotal up --user-auth`, and a broker that exits under it, now stop the user-auth service with the same stop `cotal down auth` uses. Before, that teardown took no stop reservation and never escalated past SIGTERM: a concurrent `cotal down auth` signalled the same process without seeing the stop in progress, and a service that did not exit on SIGTERM survived the teardown with its record kept. The teardown now holds the reservation and sends SIGKILL after the 15-second grace.
