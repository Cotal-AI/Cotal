---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Shell completion offers values the CLI already knows offline. `config get`, `set` and `unset`
complete the preference keys, and `config set color` and `config set harness` their values.
`docs` completes page names. `watch --view` and `space add --mode` complete their values, and a
`--space` value completes from the registered and prepared spaces on every command.
