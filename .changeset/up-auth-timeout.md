---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up --auth-timeout <seconds>` sets how long a user-auth space's broker waits for the auth callout, from 1 to 60 seconds. `up` renders it as `authorization { timeout: N }` in the broker config and starts the space's auth service with the same value as its callout deadline, so the two never differ. The value is recorded in `.cotal/broker-policy.json`, and a later `cotal up` on the root renders it again without the flag, after `cotal down` or a preserved resume included. A running broker refuses a different value. Before, the broker config had no `authorization` block and no flag set one, so a hand-applied timeout was lost the next time `up` wrote the config. `serverConfig` takes the timeout as `authTimeout`, and renders no block without it, so existing configs are unchanged. The auth-service daemon, a `--callout-only` replica included, takes `--auth-timeout <seconds>`.
