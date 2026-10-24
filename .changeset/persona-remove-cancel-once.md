---
"@cotal-ai/cli": patch
---

A cancelled `persona remove` now says once that it was cancelled and where the persona is kept, and
its `USER_CANCELLED` warning says nothing was removed. It used to print "persona removal cancelled"
twice.
