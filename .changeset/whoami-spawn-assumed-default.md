---
"@cotal-ai/cli": patch
---

In a folder whose `.cotal/` names no space, as after `cotal space forget`, `cotal whoami` and `cotal spawn --dry-run` keep exit 0 and the `Mesh: main` heading, and now add a line saying the held default `main` was assumed. Their JSON `target` names the folder as `root` and that space as `assumed`, where it used to name a space `main` that does not exist.
