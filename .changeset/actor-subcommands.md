---
"@cotal-ai/auth": patch
---

`cotal actor` takes `grant`, `revoke` and `list`, but declared none of them, so `cotal help actor` had no Commands section and shell completion after `cotal actor` offered only options. It now declares the three, with their own help, and completion offers them.
