---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A file where the Cotal config folder belongs no longer breaks every command with a misleading
"corrupt extensions manifest" error. Help, version and docs run, and every other command is refused
with `SCHEMA_INVALID` naming the file and how to move it aside, with the envelope under `--json`.
