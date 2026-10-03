---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
---

`cotal status` now has one Machine row per installed connector instead of fixed `Claude` and `OpenCode` rows. Each row reports whether the executables that connector declares in `requires` are on PATH, so a machine running Codex, jcode, pi or Hermes sees its harness. The `Claude plugin` and `Claude skills` rows now come from the Claude Code connector: a setup provider may declare a read-only `status`, and `cotal status` and the setup card print the rows it returns. A machine without the Claude connector no longer shows them. The extensions manifest caches each connector's setup ref, so status imports only connectors that declare a provider, and the seed reconcile refreshes a seeded entry whose cache predates it instead of checking the Claude connector by name. The debug handoff that `cotal setup` offers when a step fails now comes from connectors: a setup provider may declare an `assist`, and the menu offers one `Debug it with <harness>` option for each present connector that declares one. The Claude Code connector declares the existing Claude handoff. When no connector can host a handoff, the menu says so instead of silently omitting the option.
