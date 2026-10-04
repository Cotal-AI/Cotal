# Smoke kit

Private helpers for the repository's smoke suites. Shipped code must not import this package.

Use `freePort()` when a suite or its child needs a loopback port. It never returns the same port
twice in one process. The probe listener is closed before the number is returned, so another
process can still take the port before the listener binds it. Start the listener with
`onFreePort(start)` so that loss starts it again on a new port, up to five times. `start` rejects
with `EADDRINUSE`: `listenOn` does for a listener in the suite's own process, and a child that
reports the collision in its output is rejected with a `PortInUseError`. Ask for every port this
way; a number derived from another port was never checked by the OS.

A port a suite keeps as a dead address stays dead only against ports taken through the kit. A
direct `listen(0)` in the suite, or a child that binds port 0 itself, can still be given it.

Use `SMOKE_BROKER_TOKEN` as the prefix for a broker's temporary directory and register the child
with `teardownOnSignal`. The token records its owning process. Normal-path cleanup still belongs
to the suite.

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
