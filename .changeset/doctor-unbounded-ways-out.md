---
"@cotal-ai/cli": patch
---

`cotal doctor auth` now says how to end an unbounded agent credential, such as one `auth mint` wrote without an expiry: rotate the space identity (`cotal down`, `cotal reset space <space>`, `cotal up`) to retire it with every other credential the space issued, or remove the named file and mint a replacement with `--expires-in` or `--expires-at` to bound it. The finding now says a copy stays valid until the space identity rotates.
