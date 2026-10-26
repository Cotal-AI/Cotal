---
"@cotal-ai/cli": patch
---

`cotal up` in a running project, its subfolders included, says that the space already runs there.

A start naming another address with `--server` or `--host` refused as though the name belonged to another folder, and offered to start a separate space in the folder that is already that space's project. It now names the address the space runs at, the bare `cotal up` that reaches it, and the `cotal down` in its root. A refresh that finds the mesh already running reports it like any other start: the `Mesh:` heading first, then its line, and a Next that names the launch and the stop. It used to print one line with neither.
