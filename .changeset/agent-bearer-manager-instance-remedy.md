---
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

`cotal agent-bearer --manager-call` is now told to name a manager with `--manager-instance <instanceId>` when an owner has more than one live manager. Before, it was told to use the instance argument, which only an agent's tools take. The exchange names `--manager-instance` for every actor-token caller, because `cotal agent-bearer` is that arm's one client, and the connector renames it to the `instance` argument when it runs the command for a tool. The refusal still refuses and still lists the owner's live manager instance ids.
