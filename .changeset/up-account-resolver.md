---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`cotal up --account-resolver full` starts the broker on nats-server's full account resolver, so a host can add and retire space accounts on the running broker with `pushAccountClaim` instead of rendering the configuration again and reloading. `up` renders the resolver on `<root>/.cotal/account-jwts`, created owner-private, with deletion off, and records the choice in `.cotal/broker-policy.json`, so a later `cotal up` on the root renders it again without the flag. `--account-resolver memory` on a stopped root takes the record back. A running broker refuses a different value, because nats-server switches resolvers only at start, and `--open`, `-f` and `--restore` refuse the flag. A renderer outside `up` passes `brokerAccountResolver(root, readBrokerPolicy(root)?.accountResolver)` from `@cotal-ai/workspace`, so its render names the same directory and limit. Before, `up` always rendered `resolver: MEMORY`, so a broker it started could never take a pushed account, and a host that rendered the full resolver had its next reload refused.
