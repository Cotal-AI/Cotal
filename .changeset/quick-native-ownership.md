---
"cotal-ai": patch
"@cotal-ai/workspace": patch
---

Windows daemon ownership checks load fewer modules before reading the scheduled task.

The observer uses the installer's shared receipt, source, action and principal checks through a small read-only entry. Native command and observation budgets stay unchanged, and each observation reads fresh ownership facts.
