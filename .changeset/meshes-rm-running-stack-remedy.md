---
"@cotal-ai/cli": patch
---

`cotal meshes rm` of a running stack no longer says `cotal down` drops its record. A stack's `down`
keeps it as a prepared space at its root, which `meshes rm` cannot remove, so the refusal now names
`cotal space forget <space>`. A legacy root, whose `down` drops the record, keeps the old wording.
