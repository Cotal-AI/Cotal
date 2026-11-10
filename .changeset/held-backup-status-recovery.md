---
"@cotal-ai/cli": patch
---

Status now leads with recovery when an interrupted backup create or restore holds the store.
Its Next section and JSON hints use the maintenance journal's recovery step instead of offering
a restart that would refuse. Ready preserved cuts and committed restores keep their existing advice.
