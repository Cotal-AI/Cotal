---
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-core": patch
---

Remove the `face:` viewer activation that leaked from the frontier-faces example into shared connector code.

`@cotal-ai/connector-opencode` no longer reads an agent file's `face:` key, injects a face-steering
prompt, or swaps the attached TUI for a face viewer — so an OpenCode persona with a `face:` field boots
normally instead of crashing when no face runtime is present. `@cotal-ai/connector-core` no longer strips
`[[face:X]]` tags from `cotal_send`/`cotal_dm`/`cotal_anycast`; the platform-neutral tool surface sends
text verbatim. Face rendering now lives entirely in `examples/04-frontier-faces`, which owns its own
launcher (`mesh-face.mjs`) and expression steering.
