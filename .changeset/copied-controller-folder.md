---
"@cotal-ai/cli": patch
---

A copied or moved controller project folder no longer gets an "unsupported shape" refusal. The stack journal records the absolute folder it was written in, and in a `cp -a` copy or a renamed folder it named the old path, so `up` (and every other command that reads the journal) refused `SCHEMA_INVALID` with a literal `<root>` in its Next. A well-formed journal that names another folder now refuses `CONFLICT` (exit 2) and names that folder: a copy is told to use the stack from the original, and a moved folder to move back there first. A malformed journal still refuses `SCHEMA_INVALID`, and its Next now names the journal's real path. `space create` in a copy whose records name another root as their space's root says that the records were copied or moved from there, rather than calling the copy that space's root while `status` names the original.
