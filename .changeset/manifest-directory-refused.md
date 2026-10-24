---
"@cotal-ai/cli": patch
---

`cotal topology view -f <folder>` and `cotal up -f <folder>` no longer print a raw `EISDIR` error.
They refuse with exit 1, naming the path, that it is a directory, and the manifest file to give
instead.
