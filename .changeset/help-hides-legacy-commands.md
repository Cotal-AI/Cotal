---
"@cotal-ai/cli": patch
---

`cotal help` no longer lists the legacy `meshes` and `personas` commands, and completion no longer offers them. Both still run, and `cotal help meshes` and `cotal help personas` still print their help, now marked `(legacy)` and naming the replacement: `cotal space`, `space add` and `space forget` for `meshes`, and `cotal persona` for `personas`. The redesigned commands have carried the same work since 0.91.0, so the listing showed two entries for every registry and persona task.
