---
"@cotal-ai/workspace": patch
---

Windows daemon startup and manual updates read cleanup directory ownership without starting PowerShell.
The native reader keeps the directory identity and link checks, and cleanup retains the same ownership and deletion rules.
