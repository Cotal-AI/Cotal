---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"cotal-ai": minor
---

A project's own `.cotal/config.json` can now declare MCP servers and `spawn.env` names only in a folder you trust, and the new `cotal trust <path>` command trusts one. A spawn from any other folder whose project config declares either one refuses, names the folder and that command, and launches nothing. The file's other fields still apply. A project config whose file or `.cotal` folder belongs to another account is refused. `cotal setup`, `cotal space create` and `cotal up` trust the folder they prepare or start a space in, unless its config already declares servers or `spawn.env`. On upgrade, every root of a space registered or prepared on this machine is trusted, so those projects keep working. Trust is kept in `trusted-projects.json` in the operator config folder. `loadCotalConfig` in `@cotal-ai/core` now takes a second argument that answers whether a project folder is trusted; `@cotal-ai/workspace` exports `isTrustedProject`, `trustProject` and `trustCreatedProject`.
