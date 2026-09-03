---
"@cotal-ai/connector-jcode": minor
---

connector-jcode: keep a seat name launchable after the seat is stopped or reaped.

The short socket alias at `/tmp/jc-<hash>/home` is derived from the seat home, so one seat name
reuses one path for the life of the machine. A launch handed that path back on teardown while a
Jcode server the dead lifecycle left running was still using it as its `JCODE_HOME`, that server
re-created the path as a real directory, and refusing a non-symlink there retired the name for
good: every later launch of it failed before Jcode started, reporting `(unknown)` and pointing at a
private log the failure had never reached.

The alias is now reclaimed rather than refused. Each launch also records its identity nonce and its
host process in the private home, and the seat's next launch stops the Jcode tree that record names
once the recorded host is provably gone, so a lifecycle killed without its teardown no longer holds
the seat's runtime directory for five minutes. A tree whose connector is still alive is left to
Jcode's own runtime-directory lock. Failures preparing that private state now report a
`private_state` code instead of `unknown`.
