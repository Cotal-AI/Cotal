---
"@cotal-ai/cli": patch
---

A store folder now belongs to one space. `cotal up --store-dir`, with or without `-f`, refuses
`CONFLICT` when another space's registration, stack journal or broker configuration names the
folder, or when the folder holds that space's streams, and names the space, its root and its
streams. `reset store`, `reset space`, `clean store` and `clean all`, and their dry runs, refuse such
a folder the same way instead of deleting the other space's data with it. A folder an earlier release
let two spaces share still starts from its recorded store with a `STORE_SHARED` warning. A
controller stack whose recorded store folder is missing starts empty and warns `STORE_MISSING`.
