---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Recover interrupted Linux and macOS self-updates once their recorded package child process group has exited.
Gate child execution on custody publication and preserve the group, boot identity and leader start token after a signal, so plain retries do not require hidden-marker removal. Reused process IDs and zombie-only groups do not keep an interrupted update blocked. Older records without sufficient custody evidence and Windows retain their existing refusals with inspection guidance.
