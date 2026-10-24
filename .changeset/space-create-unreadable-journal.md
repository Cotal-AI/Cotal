---
"@cotal-ai/cli": patch
---

`cotal space create` in a folder whose stack journal is not valid JSON said the folder was already the root of the space whose trust it keeps, and named another folder as the way out, for any space name and also after `cotal space forget`. It now refuses `SCHEMA_INVALID`, exit 1, naming the journal and the way out, as `up` and `down` do. When no space is recorded at the folder, as after `space forget`, that way out no longer promises saved definitions: it says to remove the journal and run `cotal up`.
