---
"@cotal-ai/cli": patch
---

`space add` of a space this machine started, or one a catalog lists, now says so in its refusal
and points to `cotal space show <name>`. Before, the refusal offered `--force`, which is then
refused for that space.
