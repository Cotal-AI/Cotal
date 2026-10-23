---
"@cotal-ai/cli": patch
---

`cotal status --components` now prints `static reconciliation not reported by this manager build` only when a manager answered without that field. A manager row refused over an unattributable or unreadable pidfile, a missing login, or a probe that reached no manager no longer carries the line, so the row points at the pidfile, credential or rail it names instead of at the manager's build.
