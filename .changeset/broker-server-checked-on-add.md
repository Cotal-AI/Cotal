---
"@cotal-ai/cli": patch
---

`cotal service add <name> --preset broker` saved a `--server` that was no broker address, such as `"hallo welt"` or a port with a letter in it, while it checked `--config` and `--binary`. `service start` then refused `UNSUPPORTED` naming neither the option nor the value, and recorded a failed instance. `add` now refuses that address before it saves anything, from the preset, a `--file` definition or the guided prompts, quoting it unless it holds an `@`. A definition saved earlier names its `server` option and the address on start, with the steps to add it again.
