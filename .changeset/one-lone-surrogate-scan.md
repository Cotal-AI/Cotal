---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
---

`assertValidName` and `spaceKey` now use the exported `isWellFormedUnicode` instead of their own copies of the lone-surrogate scan, so the check is written once. Which strings they accept and refuse, and their error messages, are unchanged.
