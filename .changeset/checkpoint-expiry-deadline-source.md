---
"@cotal-ai/lang": patch
"cotal-ai": patch
---

A checkpoint that expires under `onExpiry: "fail"` now says in its L4007 whether the deadline came
from its own `timeout` or from the run's default, and its last option matches: raise the
checkpoint's timeout, or give it one or start the run with a longer default. The two used to print
the same text.
