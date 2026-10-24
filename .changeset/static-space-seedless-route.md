---
"@cotal-ai/cli": patch
---

`cotal space add` and `cotal meshes add` refused for a static-auth space whose trust is not in `--root` no longer offer `--mode open`, which a broker that requires auth refuses. They now name what a machine without the space's signing seed can use instead: a credential the owner mints with `cotal auth mint`, passed with `--creds <file> --server <url>`.
