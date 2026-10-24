---
"@cotal-ai/cli": patch
---

`cotal space show` and `cotal use` with an unregistered name now head their refusal `Mesh: <name>` and carry the name in `target.space`, as `space forget` and `space delete` do.
