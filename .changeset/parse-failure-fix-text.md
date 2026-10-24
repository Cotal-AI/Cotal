---
"@cotal-ai/lang": patch
---

A program that does not parse, such as one holding a NUL byte, is still refused with L1008, and its
fix now says only to fix the syntax at the marked position. It used to say the language has no
automatic semicolon insertion, which it does.
