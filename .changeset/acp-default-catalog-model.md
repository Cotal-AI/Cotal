---
"@cotal-ai/acp": patch
---

ACP threads now start the agent on a model named `default` when the application lists one, and `/open` updates the client's model list. Choosing `<application>/default` spawns the agent with `model: "default"` and the chosen reasoning when the application's catalog lists a model with that id, as a custom Hermes endpoint can; otherwise the spawn still names no model and the application picks its own. After `/open`, the client gets the opened agent's options in a `config_option_update`, as it does when an option changes.
