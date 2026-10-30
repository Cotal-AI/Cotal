---
"@cotal-ai/connector-jcode": minor
---

Require Node 22.13 or later for the Jcode connector (23.4 or later on Node 23). Cursor credential mirrors now contain only the three values used by Jcode, instead of copying the entire editor-state database into every seat. Read-only SQLite queries include committed WAL updates; private atomic publication, login rotation and removal are preserved. Existing full mirrors are replaced when their seats next launch. Provider selection and external-auth consent are unchanged.
