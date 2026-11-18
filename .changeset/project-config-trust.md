---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"cotal-ai": minor
---

A project's own `.cotal` can now declare MCP servers, `spawn.env` names and persona launch options only in a folder you trust, and the new `cotal trust <path>` command trusts one. A spawn that reads any of them from another folder refuses, names the file, the entries, the folder and that command, and launches nothing, both in this terminal and through a manager. The config file's other fields still apply, and a persona file outside any project and `--opt` on the command line are not affected. A project config whose file or `.cotal` folder belongs to another account is refused. `cotal setup`, `cotal space create` and `cotal up` trust a folder only when they made its `.cotal` in that run; a folder that arrived with one, such as a cloned repository, is trusted only by `cotal trust`. The first command at this version writes `trusted-projects.json` in the operator config folder once, trusting every root a space was registered or prepared at before it, so those projects keep working. Trust follows the stored path. A trusted projects file another account owns or may write trusts nothing. `loadCotalConfig` in `@cotal-ai/core` now takes a second argument that answers whether a project folder is trusted; `@cotal-ai/workspace` exports `isTrustedProject`, `trustProject`, `seedTrustedProjects` and `personaLaunchOptionsRefusal`.
