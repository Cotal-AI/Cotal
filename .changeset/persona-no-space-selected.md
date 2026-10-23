---
"@cotal-ai/cli": patch
---

`cotal persona` with no space selected, outside a project, now says that no space is selected and this folder is not a space's project. It said `no mesh running`, though the catalog is read offline and needs no running mesh. Commands that read the same catalog, such as `cotal team`, give the same message.
