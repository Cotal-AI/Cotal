---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

A help usage whose bracketed group is wider than the terminal starts that group on the line before it when its opening piece fits there, so `cotal help daemon` starts `cotal daemon <setup|status|...` and `cotal help service-endpoint` starts `cotal service-endpoint <approve <proposalId> |`, where `cotal` sat alone on the first usage line. The same applies to `auth`, `run`, `team`, `manager`, `service`, `endpoint`, `channel`, `send` and `watch` at the widths where their group wraps. The `service-endpoint callers` example's note is now "list who may call it", so each `service-endpoint` example fits one 80-column line with its note.
