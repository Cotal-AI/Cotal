---
"@cotal-ai/connector-opencode": patch
---

Move the OpenCode plugin's write-ahead-log reap, its authenticated HTTP client and its two `session.error` readers out of `cotal` into a new `plugin-io.ts`. Behaviour is unchanged.
