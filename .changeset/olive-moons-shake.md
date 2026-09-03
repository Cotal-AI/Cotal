---
"@cotal-ai/cli": minor
---

Resolve the persona catalog from the target mesh rather than the current directory.

`cotal personas` listed the personas of whatever directory it ran in, while `cotal spawn` launched from the mesh it resolves — so from one directory the two could name completely different sets, with neither saying anything was wrong. Every `cotal personas` subcommand now reads and writes the resolved mesh's catalog, which also makes `--space` and `--server` real for the listing rather than only for the live `--running` overlay: naming a mesh now moves the catalog, and an unresolvable target refuses instead of silently acting on another directory's files. `cotal spawn --role`/`--subscribe` and `cotal send msg`/`ask` complete from that same catalog.

The library functions behind this (`personasDir`, `listPersonas`, `listPersonaNames`, `listDeclaredChannels`, `listDeclaredRoles`) now require an explicit root instead of defaulting to the current directory, so a caller that omits one fails to compile rather than answering about the wrong place.
