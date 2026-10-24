---
"@cotal-ai/cli": patch
---

`backup restore` now refuses a manifest that names an invalid space as an invalid manifest. A
space longer than 200 characters passed restore's manifest checks and reached the same-space check,
which refused `CONFLICT` and printed the whole space in its message, remedy and JSON target. Restore
now refuses it `SCHEMA_INVALID` with `file` `manifest.json` and fault `manifest-invalid` before it
stages anything, as `backup verify` does, and prints no space.
