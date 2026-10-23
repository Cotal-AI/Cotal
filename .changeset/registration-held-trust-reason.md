---
"@cotal-ai/cli": patch
---

`space add` and `meshes add` against a broker that requires auth, with a `--root` that holds another
space's trust, now say that the folder holds the trust for that space and refuse with
`DEPENDENCY_UNAVAILABLE`. Before, they said to copy the mesh's credentials there and re-run with
`--mode auth`. The note on what such a copy carries is now part of the same line, so `space add` no
longer prints a literal `\u000a` in its message.
