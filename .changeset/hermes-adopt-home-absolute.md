---
"@cotal-ai/connector-hermes": patch
---

The Hermes launcher now refuses a `COTAL_HERMES_ADOPT_HOME` that is not an absolute path, before it writes anything. A relative value used to resolve against whatever directory the launcher ran in, so the same setting installed the plugin into a different directory, or failed as missing, depending on where the seat started, and a literal `~/.hermes` that no shell expanded was taken as a directory named `~`. `docs/connect-hermes.md` now says the value must be absolute.
