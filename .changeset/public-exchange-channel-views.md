---
"@cotal-ai/auth": minor
"@cotal-ai/connector-core": minor
---

The public user-auth exchange now mints `channel-writer` and `channel-purger` for a signed-in
human whose ledger row carries `admin`, so a remote owner can run `cotal channels set/default`
and a dashboard channel delete without a loopback capability. `admin`, `purger`, `deployer`, and
`manager-service` stay loopback-only. A managed-agent secret exchange still never mints a view.
This is not full remote channel management: `cotal web` still asks for the read-only admin view
at startup.
