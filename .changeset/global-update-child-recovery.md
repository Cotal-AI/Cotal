---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Recover interrupted Linux and macOS self-updates once their recorded package child process group has exited.
Gate child execution on custody publication and preserve that evidence after a signal, so plain retries do not require hidden-marker removal. Older records without sufficient custody evidence and Windows retain their existing refusals.
