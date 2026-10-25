---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A manager command such as `cotal ps`, `cotal stop` or `cotal spawn --on`, and `cotal send` with the other commands that open a one-shot connection, now connects again when the broker refuses the connection or it does not open within 5 seconds: nothing was sent, so up to 4 attempts are made 1 second apart. A view the auth service refused for a moment, or an auth service that answered after the broker's callout timeout, now just works. These commands used to stop at the first refusal, or wait 20 seconds and end as `OPERATION_UNKNOWN` (exit 3) with a bare `timeout`. When every attempt fails, the command says nothing was sent and is refused, exit 2: `PERMISSION_DENIED` when the broker refused each attempt and `TARGET_UNAVAILABLE` when none opened in time. An endpoint takes a `transportConnectTimeoutMs` option for its first connect.
