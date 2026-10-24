---
"@cotal-ai/cli": patch
---

`cotal down -f <folder>` no longer prints a raw `EISDIR` error. It refuses with exit 1, naming the
path, that it is a directory, and the manifest file to give instead, as `topology view -f` and
`up -f` do.
