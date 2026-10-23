---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`--creds` reads and checks its file before dialing. A missing, empty or malformed file (CRLF line
endings, a truncated JWT, no seed block) and a directory are refused naming the file and the cause,
instead of reporting a serving broker as unreachable or dumping the command's help. A file other
accounts can read is still used, with a warning that names `chmod 600`.
