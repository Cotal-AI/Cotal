---
"@cotal-ai/cli": patch
---

`cotal send --file` refuses a directory and a file that is not UTF-8 with `USAGE_INVALID` in the same refusal block as a missing or unreadable file, naming the path and without the command's help. A directory used to get a bare line followed by the whole usage block, and the UTF-8 refusal did not name the file.
