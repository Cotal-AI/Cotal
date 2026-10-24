---
"@cotal-ai/lang": patch
---

L1008 is now titled "Invalid syntax or newline hazard", since a program that does not parse, such as
one holding a NUL byte, is refused under it as well as the two newline hazards. The code is unchanged.
