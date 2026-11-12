---
"@cotal-ai/lang": patch
---

Refuse a workflow whose text is only comments or whitespace. Validation reports L1031, program has no statements. An empty file is still refused before validation, and a lone empty statement remains a program.
