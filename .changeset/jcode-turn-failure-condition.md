---
"@cotal-ai/connector-jcode": patch
---

A Jcode seat whose turn fails with a Harness-reported error, such as a provider `rate_limit`, now relays that error code as its presence `condition`. The roster, `cotal status` and `cotal endpoints` show `waiting (rate_limit)` until the next successful turn clears it. Before, the seat read plain `waiting` and the error was recorded only in its private connector log.
