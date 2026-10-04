# Smoke kit

Private helpers for the repository's smoke suites. Shipped code must not import this package.

Use `freePort()` when a suite or its child needs a loopback port. Ports come from 20000-26383,
below the kernel's ephemeral range, so no bind of port 0 and no outgoing connection on the host can
be given one. A lock listener held until the process exits keeps every other caller of the kit, in
this process or another, from getting the same port, so an address a suite keeps as dead stays
dead. A call that throws closes its lock and leaves nothing listening. On Linux the kit reads the
ephemeral range and throws when it overlaps 20000-32767. macOS and Windows default to 49152-65535.

The probe listener is closed before the number is returned, so a process that binds the number
itself, without asking the kit, can still take the port first. Start the listener with
`onFreePort(start)` so that loss starts it again on a new port, up to five times. `start` rejects
with `EADDRINUSE`: `listenOn` does for a listener in the suite's own process, and a child that
reports the collision in its output is rejected with a `PortInUseError`. Ask for every port this
way; a number derived from another port was never checked by the OS.

Use `SMOKE_BROKER_TOKEN` as the prefix for a broker's temporary directory and register the child
with `teardownOnSignal`. The token records its owning process. Normal-path cleanup still belongs
to the suite.

`recordSmokeSandbox` also owns every process that works inside the recorded root. The first
record starts a small `sh` watchdog that outlives the suite. When the suite's process ends, however
it ends, SIGKILL included, the watchdog kills whatever still works in a recorded root, including the
broker, manager and delivery daemon that `cotal up --detach` starts detached. A stack the suite
already stopped leaves nothing to kill. A hook inside the suite cannot do this: tsx turns a signal
the suite does not acknowledge within a few tens of milliseconds into SIGKILL, and a suite waiting
in `spawnSync` cannot acknowledge one. The watchdog finds processes through Linux procfs, so
nothing is watched on other platforms.

The CI shard runner also assigns each suite a `SMOKE_BROKER_SCOPE`. This non-secret test marker
is separate from `COTAL_*` connection settings, so their normal scrub leaves it intact. The token
carries a compact digest of the scope; Linux descendants can also recover it from ancestor
environments if their own environment was cleared. The post-suite reaper checks only that scope and still refuses to kill a broker whose
owner is alive. A foreign owner exiting during a suite does not make its broker that suite's leak.
Standalone suites without a scope retain the unscoped token. The pre-run sweep remains global.

This does not enable concurrent scheduling or change seat custodian markers. Ancestor recovery
uses Linux procfs. On other platforms, the broker-owning process must inherit the scope in its
environment. The reaper reports when its platform cannot enumerate brokers.

The serial shard runner sets the scope before launching each suite. Existing environment
inheritance stays unchanged, including caller-supplied test pins, budgets and private paths.
Each suite remains responsible for isolating the environments of its own children.
