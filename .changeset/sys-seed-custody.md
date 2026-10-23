---
"@cotal-ai/workspace": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
---

Own-broker service caller issuance. `cotal up` retains the system-account signing seed in the root's secret store, beside the seed-free trust record, at space creation and at `--rotate-sys` (the successor's seed replaces the retired account's). An auth service started with `--service-endpoints` composes the caller payload bootstrap from that record when it names the trust record's system account and the seed derives it: each bootstrap mints one 60 s VARZ-only observer credential, and the seed never leaves the daemon. A root with no retained seed opens the engine and door without caller issuance and says why; a record for another account refuses the start. `@cotal-ai/workspace` exports `retainSystemSigningSeed`, `readSystemSigningSeed` and `systemSigningSeedKey`.
