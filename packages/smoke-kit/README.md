# Smoke kit

Private helpers for the repository's smoke suites. Shipped code must not import this package.

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

The shard runner removes inherited `COTAL_*` connection settings from suite environments. It
passes the test inventory, worker/time budgets and connector-seeding switch explicitly, alongside
the run marker and the suite's broker scope.
