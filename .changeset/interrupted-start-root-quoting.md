---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

Quote the recorded root in `status` recovery commands for an interrupted startup, preserving spaces
and apostrophes when copied into a shell. The existing `--no-manager` choice is preserved. Startup
state, recovery actions and their order are unchanged; no command is run automatically.
