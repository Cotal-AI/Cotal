---
"@cotal-ai/connector-opencode": patch
---

On OpenCode 2.x, the plugin now starts its mesh agent only after OpenCode has accepted every session and tool hook registration. The start used to be queued first, so a registration OpenCode rejected failed `setup` with no teardown returned while the agent still joined the mesh, and it stayed on the roster with no hooks wired to it until the process exited.
