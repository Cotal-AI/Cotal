---
"@cotal-ai/workspace": patch
---

Refuse a malformed mesh registry record by name instead of crashing the command that reads it. A
parseable record missing `server`, `mode`, `root`, or `ts` (or carrying a `mode`/`origin` this build
does not know) reached the registry listing and crashed `cotal meshes` with a bare TypeError while
`cotal status` rendered `undefined` columns; an unparseable record was silently skipped, hiding it
from `cotal meshes rm` too. `loadMeshes` now validates every record and fails loud with the file
path and the reason, so the operator learns which file is wrong. Every command that loads the
registry shares the refusal.
