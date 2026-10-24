---
"@cotal-ai/cli": patch
---

`cotal service add <name> --file <definition.json>` looked the name up in the selected space before it read the file. A file for another space, named like a service the selected space already has, was refused `CONFLICT` "already exists" with a next step that removes the selected space's service. The file is now read first, so it gets the `SCHEMA_INVALID` refusal that names both spaces, as it does under a fresh name.
