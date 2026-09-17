---
"@cotal-ai/cli": minor
---

Refuse to re-exec a detached daemon from an entry that is not the CLI

`selfArgv()` builds the argv every detached re-exec is spawned with: `[node, ...loaderFlags,
process.argv[1]]`, plus a cotal subcommand the caller appends. It took `process.argv[1]` on trust.
Under tsx that is whatever file was run, so a process started from something other than the `cotal`
entry spawned a child that re-ran THAT file with `supervise`, `deliver` or `ext add` appended, which
the file does not read. A test fixture reaching `ensureControlPlane` therefore spawned a copy of
itself as its own manager, and the copy reached the same call and spawned the next: 970 detached
generations over 4.7 hours on a persistent host, each holding a nats-server and a delivery holder.
The guard cannot live in the test harness, because `startManagerDetached` unrefs its child on
purpose and nothing can adopt it.

`selfArgv()` now refuses unless the entry is the CLI's own composition root: `bin/cotal.ts` in a
source checkout, `dist/cotal.js` in an install, or a bare `cotal`, which is what `npm i -g` leaves
in `process.argv[1]` because it publishes the bin as a symlink. The refusal names the entry, says
what a child spawned from it would actually run, and names the remedy. It is a throw rather than a
skipped spawn: a re-exec that silently does not happen reports a healthy control plane over nothing.

The manager, delivery and auth starters now build that argv before they open the daemon logfile, so
a refused start leaves the mesh root exactly as it found it instead of creating a log and leaking
its descriptor.
