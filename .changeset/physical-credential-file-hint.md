---
"@cotal-ai/workspace": patch
---

When a directory in an explicit credential file path is a symbolic link, the suggested physical path now includes the filename. The original path is still refused before connecting.
