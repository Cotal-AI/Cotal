# Seed scenarios

These files contain the existing compiled-CLI seed scenarios. `pnpm smoke:seed`
builds the binary and runs every scenario with three workers when Node reports
at least four available CPUs, and two otherwise. Each has fresh state; the
four-boot contention scenario still shares one prefix internally. The worker
budget does not cap the scenarios' subprocesses.

`COTAL_TEST_JOBS` overrides this budget; use 1 for serial execution or 2 to reduce
memory use on larger hosts. `COTAL_TEST_TIMEOUT_MS` sets the
per-scenario budget (420000 by default). The direct-supervise check retains its
90000 ms deadline. Output is printed in the original order, and an assertion
failure does not skip later scenarios. Failed runs retain each scenario's tally
and print a failed parent banner rather than claiming a complete aggregate tally.

For isolated local measurements, prepare a private npm download cache before
entering the no-egress user/network namespace, then enable npm offline mode.
Do not copy seeded application state or point these commands at an operator home.
