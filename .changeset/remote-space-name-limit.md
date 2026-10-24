---
"@cotal-ai/cli": patch
---

`cotal space add` and `cotal meshes add` accepted a space name longer than 64 characters, which the local files that carry a space cannot hold, and from 117 characters failed with `ENAMETOOLONG`. They now refuse `USAGE_INVALID`, exit 1, naming the limit, and write nothing.
