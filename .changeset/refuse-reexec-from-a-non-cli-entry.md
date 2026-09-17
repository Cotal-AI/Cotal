---
"@cotal-ai/cli": minor
---

Refuse to re-exec a detached daemon from an entry that is not the CLI

`selfArgv()` builds the argv every detached re-exec is spawned with, and each caller appends a cotal
subcommand to it. It took `process.argv[1]` on trust, so a process started from another file, such
as a test suite under tsx, spawned a copy of that file as its manager, and a copy that reached the
same call spawned the next one. `selfArgv()` now throws unless the entry is the CLI's own. The
refusal names the entry, says what a child spawned from it would run, and names the remedy. It is a
throw rather than a skipped spawn, because a re-exec that silently does not happen reports a healthy
control plane over nothing.

The manager and delivery starters build that argv before they open their daemon logfile, so a
refused start of either one no longer creates a log or leaks its descriptor.
