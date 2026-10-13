---
"@cotal-ai/manager": patch
---

A manager spawn reads the cotal config once and uses that one value for the delegated-runtime refusal of shared MCP servers, the model policy check and the launch's shared servers and `spawn.env` allowlist. Before this the launch read the file again after the presence snapshot, the accept hooks and provisioning, so a config edited in that window admitted the seat under the old model policy and launched it with the new file's servers and env names.
