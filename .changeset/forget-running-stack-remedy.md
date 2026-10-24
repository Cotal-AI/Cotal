---
"@cotal-ai/cli": patch
---

`cotal space forget` of a running stack no longer says `cotal down` drops the space's record. A
stack's `down` keeps it as a prepared space at its root, so the refusal now names `cotal down` and
then `space forget` again. A legacy root, whose `down` drops the record, keeps the old wording.
