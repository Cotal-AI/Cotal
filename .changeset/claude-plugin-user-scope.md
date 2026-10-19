---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

`cotal setup` now installs the `cotal` Claude Code plugin for your user account, so every Claude Code session on the machine gets the `cotal_*` tools in any project: the terminal, the IDE extensions and the Desktop app's local Code sessions. It used to install it only for the project setup ran in. Running `cotal setup` again moves the per-project installs an earlier release made under the one user-scope install. `cotal update` still only rewrites the plugin copy and does not change where it is installed. If Claude Code cannot change one project's settings, setup still removes the others and writes the Claude Desktop entry, then fails naming that project and the `claude plugin uninstall` command to run there. `cotal status` reads `current (user scope)`. Setup and `cotal status` now read a plugin list longer than 1 MiB, which a machine with many old per-project installs reaches; before, the output was cut short and status showed `unknown`. A session Cotal launches still loads one cotal server, because its `--plugin-dir` copy replaces the installed one for that session.

The plugin's hook, which Claude Code starts for every tool call, prompt and stop, no longer bundles the `@cotal-ai/core` package root. It shrinks from 945 KB to 14 KB and starts in about half the time. `peerLabel` is now also exported from the new `@cotal-ai/core/peer-label` subpath, and the root export is unchanged.
