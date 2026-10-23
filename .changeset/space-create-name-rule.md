---
"@cotal-ai/cli": patch
---

`space create` refuses a name that `cotal up` cannot start, such as one with a space, a dot or a
non-ASCII letter, with `USAGE_INVALID` before anything is written. Such a name used to be prepared,
and the first `up` in its folder then refused it and left the folder held by that name.
