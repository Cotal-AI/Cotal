---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/runtime": minor
"@cotal-ai/lang": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

A read or post grant can now keep a wildcard and exclude channels or patterns from it, for example `allowSubscribe: { allow: [">"], exclude: [secret] }`. Exclusions are broker deny rows signed only for nats-server 2.12.7+ on the 2.12 line or 2.14.0+, and history under an excluded wildcard is served by the delivery daemon's new `readRange` read, which drops excluded posts before it pages. Joins, mentions and stored copies apply them, delegation keeps them exactly, and spawn, persona, mint and grant commands take `--exclude-subscribe` and `--exclude-publish`. A list without exclusions is unchanged; older components refuse a list with them rather than grant the wildcard alone.
