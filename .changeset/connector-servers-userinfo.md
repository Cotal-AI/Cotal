---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

A connector session now refuses a `COTAL_SERVERS` with a user name or password when it starts. The NATS client kept only the URL's host and port, so the session dialed without them, failed authorization in a loop with nothing saying why, and printed the URL with the password in the `cotal_roster` and `cotal_channels` not-connected lines. The refusal names the variable without repeating its value, and says to pass the credential in `COTAL_CREDS`, `COTAL_TOKEN` or a `COTAL_LINK`. The URL check moves from workspace to core so the connector can use it.
