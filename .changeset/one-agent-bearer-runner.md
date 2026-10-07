---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

`@cotal-ai/core` now exports `runAgentBearer`, the one runner for an auth provider's agent bearer argv: it owns the 30-second default bound, the 64 KiB output limit and the failure sentence, and returns the printed line. The CLI's foreground preflight, the manager's local and remote enrollment preflights and the connector's bearer refresh and manager calls all run through it instead of carrying their own copy. The CLI still scrubs the enrollment variables from the child environment it passes, and the connector still refuses an empty line.
