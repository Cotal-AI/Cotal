---
---

Smoke shards are assigned by measured cost. `bin/smoke/ci-suite-costs.json` records each suite's median CI duration and pins it to a shard, and `bin/smoke/rebalance-shards.mjs` rebuilds the table from smoke job logs by moving one suite at a time from the heaviest shard to the lightest while that narrows the gap. The first table moves nine suites and evens the estimated shard times from 31 to 55 minutes to about 41 minutes each. `pnpm check:shard-stability` reports a move the table pins as `REBALANCED`, still fails any other move, names the shard each new suite lands on and prints the measured minutes per shard. This changes CI tooling only; no published package changes.
