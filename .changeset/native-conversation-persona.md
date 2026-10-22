---
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
---

A signed-in native Claude Code conversation can now adopt a persona you name.

`cotal_connect` in a native Code session takes `persona`, a name from the mesh's persona catalog on this computer and never a path. The plugin's native module moves the persona's instructions out of the tool result into its own context: the call's context for that turn, then a `cotal-persona` prompt block on each later turn until the conversation disconnects or ends. They add to Claude's system prompt, your instructions and the host's settings, and replace none of them. The card takes the persona's description, tags and display metadata. The persona grants nothing: its role, channels and capabilities are not read, and the selection alone decides access. Its model, variant, agent and launch options are not applied, and the reply names each one alongside the model Claude Code reports. The card shows that reported model, and Cotal records no model pin for it. A call the native module did not bind cannot adopt a persona or report a model, and a static-auth or open mesh refuses a persona.

The gateway gains `GatewayOptions.persona`, a `host_model` argument with `connectContext`, `ConnectProfile` as the fifth `GatewayHost.open` argument, `GatewayConnection.persona` and `personaContext`. `cotal app-identity provision` takes `--persona <name>`. The hosted gateway's tool set is unchanged.
