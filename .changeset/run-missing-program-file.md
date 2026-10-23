---
"@cotal-ai/runtime": patch
---

A workflow program file that cannot be read is now refused with `TARGET_NOT_FOUND`, exit 2, by `cotal run start`, `run start --local`, `run resume --local --file` and `run check`, as `run validate`, `plan` and `simulate` already refused it. `run start` and `resume` reported the raw `ENOENT` as an unknown outcome with exit 3, and `run check` printed it as a bare error with exit 1. The `--json` envelope now names the file as its target.
