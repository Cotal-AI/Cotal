---
"@cotal-ai/core": patch
---

An agent name that starts with `-` is now refused on every mesh, at spawn, at a persona definition and at the CLI's `--name` check. Terminal runtimes pass the name to other programs as an argument, where a leading `-` reads as an option. A name with `-` after its first character is accepted as before on open and static meshes.
