---
"@cotal-ai/workspace": patch
---

Resolve a local project against the mesh recorded for its root, whatever spelling that root arrives
under.

`resolveMeshTarget` looks up the registry entry recorded for the current project root and honours its
`server` and `mode`. That lookup compared roots with `resolve()`, which normalizes separators and
`..`/`.` but does not collapse a symlink. A recorded root is whatever spelling the operator gave:
`cotal meshes add --root <dir>` runs its root through `resolve()` too, never realpath, so a project
recorded under one spelling of its directory and started under another read as *unrecorded*: its
recorded server and mode were discarded and it was silently retargeted to the default server. A
project started on `…:4333` resolved to `…:4222`, and a recorded open mesh minted credentials off
stale local auth state. Both comparisons now use the canonical root predicate the registry already
applies in `meshesForRoot`, which is now exported rather than reimplemented at each call site.
