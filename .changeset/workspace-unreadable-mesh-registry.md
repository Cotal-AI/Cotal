---
"@cotal-ai/workspace": patch
---

A mesh registry directory that exists but cannot be read, such as one without read permission or a regular file in its place, now makes `cotal meshes` and every other command that reads the registry exit 1 with its path and the read error. Before, the registry read returned no meshes for any read error, so `cotal meshes` exited 0 with "no meshes registered" and printed no rows under `--json`. An absent registry directory is still an empty registry.
