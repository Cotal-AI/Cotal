---
"cotal-ai": minor
"@cotal-ai/cli": minor
"@cotal-ai/workspace": minor
---

`cotal status` writes one structured document with `--json` and a plain report with `--plain`, and exits by the structured outcome table. The report keeps its order (this machine, extensions, this folder, the recorded meshes, the selected mesh) and ends with the hints. Only the selected mesh is checked unless `--all` asks for every recorded one, and a part status cannot read is named on its row and makes the run `partial`. That includes a persona catalog, the current-mesh pointer and a mesh registry record: the readable records are still listed. `@cotal-ai/workspace` adds `readMeshRegistry`, `readCurrent` and `MeshRegistryError` for those reads.

Breaking: bare `status` exits 4 when it could not read part of what it reports, instead of 0. The recorded meshes other than the selected one read `not checked` without `--all`. The report lists no roster, and `--components` is refused with `--json`, `--plain` or `--all`. See the upgrade notes.
