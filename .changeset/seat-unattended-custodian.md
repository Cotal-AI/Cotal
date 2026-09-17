---
"@cotal-ai/seat": minor
---

Bound the life of an unattended seat custodian, and make a census of them cheap.

A custodian whose manager crashed or whose suite returned without reaping it waited forever for a
controller that no longer existed, holding roughly 65 MB each. A full smoke shard left about
eighteen behind per run, and they accumulated across runs until the host was under memory pressure.
They were also hard to find: the only thing tying one to its worktree was its cwd, so a census had
to walk `/proc/*/cwd`, which needs the owner's uid for every pid it inspects.

A custodian with no authenticated controller now stops its child and exits after `UNATTENDED_MS`
(ten minutes; `COTAL_SEAT_UNATTENDED_MS` overrides it at launch, and a malformed or non-positive
value throws rather than restoring the default). The window restarts at each disconnect, so a
manager that detaches and re-adopts keeps its seats.

Every custodian now carries `--cotal-run <marker>` on its argv and `COTAL_RUN` in its environment,
and `censusCustodians(run?)` reads that marker back out of `/proc/<pid>/cmdline`. The smoke shard
runner names each run and kills the custodians carrying that marker after every suite, failing the
shard for a suite that passed but leaked one, and leaving other runs' custodians alone.

The transport also refuses a socket path the kernel would truncate. `sun_path` holds 108 bytes
including its NUL; past that libuv copies into the fixed buffer, truncates, and `listen` succeeds on
the shortened name, so the custodian cleaned up a socket it never created and died without writing
its log. `launchSeat` now refuses an oversized path by name, the custodian verifies the path it
bound and logs any startup failure instead of dying uncaught, and `@cotal-ai/smoke-kit` gains
`makeSeatRoot` so a suite's custody root stays short whatever `TMPDIR` says.

`runMarker` recovers `COTAL_RUN` from the nearest ancestor that still carries it, so a suite that
scrubs `COTAL_` from a child environment does not make its custodians unattributable.
