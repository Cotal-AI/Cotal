---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

A persona file with CRLF line endings or a UTF-8 BOM now reads like the same file with LF endings, so `persona create --file`, `persona list`, `persona show`, `persona edit` and launches accept it. `persona create --file` now names the file it read when it refuses a definition, not the catalog path it would have written.
