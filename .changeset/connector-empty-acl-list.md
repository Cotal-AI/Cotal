---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

A launch that resolves an empty read or post list now hands the session that empty list. `aclEnv` used to omit `COTAL_SUBSCRIBE`, `COTAL_ALLOW_SUBSCRIBE` and `COTAL_ALLOW_PUBLISH` when the list was empty, so a `cotal spawn <persona> --subscribe ,` or `--allow-publish ,` session fell back to the persona file's channels while its credential and launch record carried none. The launcher now sets the variable to an empty value, and `configFromEnv` falls back to the persona file or join link only when the variable is unset. A hand-driven session that exports one of these variables as an empty string now gets an empty list instead of the persona's.
