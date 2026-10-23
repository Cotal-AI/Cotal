---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal auth mint --expires-at` refuses a time that is not in the future, before anything is written. It used to write a credential the broker already refused, under a label that was then taken, and `doctor auth` reported it as expired.
