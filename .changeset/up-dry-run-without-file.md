---
"@cotal-ai/cli": patch
---

`cotal up --dry-run` without `-f` is refused. The flag only applies to a manifest launch, so a plain `up` used to ignore it and boot a real mesh.
