---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run validate` and a hosted `cotal run start` now refuse an empty program file the same way, `SCHEMA_INVALID` with a next step, and `--json` gets its envelope. Before, validate passed the file, and start printed a raw input-schema line on stderr and exited 1 with no JSON.
