---
"@cotal-ai/cli": patch
---

`cotal service install` builds the manager's environment from one list that both platforms render. On macOS it no longer writes a `cotal-manager@<key>.env` file nobody reads; the plist's `EnvironmentVariables` carry the same variables as before. On Linux the unit is unchanged, and every value in its `EnvironmentFile` is now double-quoted the way `PATH` already was, so each one reaches the manager verbatim.
