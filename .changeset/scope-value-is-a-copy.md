---
"@cotal-ai/lang": patch
---

A concurrency scope now hands the program the frozen copy of its value that its record carries, live as on resume. Before, it froze the value in place. A record a branch returned from outside the scope stayed frozen for the rest of the live run but writable on resume, so a resume of unchanged source could diverge with L5001.
