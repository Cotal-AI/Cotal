---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Backup cleanup accepts a verified empty fallback without `--discard-history` even if it was preserved after the backup was made. Full restore checks the retained store on an isolated copy and keeps the guard when it cannot prove the cut was empty or when another account's streams were left out.
