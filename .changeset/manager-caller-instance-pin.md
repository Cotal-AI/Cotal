---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
"@cotal-ai/workspace": patch
"@cotal-ai/connector-core": patch
---

Callers can name a manager instance wherever a user-auth mesh with several live managers for one owner asks them to. `cotal models` and every hosted `cotal run` verb take `--on <instance>`, and MCP `cotal_run` and `cotal_personas` take an `instance` argument under the same rules as `cotal_spawn`'s. A `cotal` command run from a managed seat's shell now selects the manager that launched the seat (`COTAL_MANAGER_INSTANCE`), as the seat's tools already did, unless `--on` names another. The ambiguity refusal still refuses, and now lists the owner's live manager instance ids and names the caller's own remedy: `--on <instanceId>` for the CLI, the `instance` argument for an agent's tools. Before, it named `--manager-instance`, which only `cotal agent-bearer` takes, so none of these callers could answer it.
