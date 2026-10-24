---
"@cotal-ai/cli": patch
---

A `backup create` that runs out of disk space now says so. It failed with only the raw
`ENOSPC: no space left on device, write` as its detail, which names no file, and a Next that sent
the user to inspect the maintenance state before a recovery that was not needed. The failure now
names `ENOSPC` (or `EDQUOT`), the directory it was writing (the store copy under
`.cotal/maintenance/attempts` or the backup destination), and that the attempt removed what it wrote,
published nothing and left the preserved cut ready. Its Next frees space on that disk and runs the
same create again.
