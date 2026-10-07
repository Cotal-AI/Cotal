---
"@cotal-ai/workspace": patch
"@cotal-ai/web": patch
"@cotal-ai/cli": patch
---

The web dashboard's `web.session` record and its `x-cotal-readiness` header now have one definition, in `@cotal-ai/workspace`: the file name, the record's fields, the one reader, and the header name. The dashboard writes and reads the record through it and `cotal status` reads it there. Renaming the file, a field or the header on the dashboard side used to typecheck cleanly while `cotal status --components` read the live dashboard as `refused` and the `Web process` row read `down`; now it is a compile error on both sides.
