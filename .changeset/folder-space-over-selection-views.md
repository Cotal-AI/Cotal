---
"@cotal-ai/cli": patch
---

In another space's project folder, `status`, bare `cotal` and `help` now lead with that folder's space, the one every command there targets, while it is prepared, running or stopped. `status` names it under `Mesh:` and in a `This folder's space` section, says the selected space applies outside the folder, and carries it in `--json` as `target.space` and `meshes.folder`, where a stopped or prepared folder space used to leave both null. The entry screen points to that folder's own `cotal up`. `history clear` says it clears the space it targets, not the selected space.
