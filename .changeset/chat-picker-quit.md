---
"@cotal-ai/cli": patch
---

`/quit` in `chat --plain`'s numbered recipient list leaves the session. It used to print the list
again, so only the end of input left.
