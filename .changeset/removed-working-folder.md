---
"@cotal-ai/cli": patch
---

A command run from a folder that no longer exists is refused with `USAGE_INVALID`, exit 1, before
it does anything, and says to `cd` to an existing folder. `status` and other commands used to
report an unknown outcome, exit 3, with Node's raw `uv_cwd` error. `help`, `version` and
`completion` still work there.
