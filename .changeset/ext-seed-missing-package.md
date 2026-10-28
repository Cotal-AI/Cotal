---
"@cotal-ai/cli": patch
---

`cotal ext seed --reset` and `--repair` finish when the extensions manifest lists a package whose directory is gone, including one npm removes during the install because the prefix does not list it. The reseed reports that package, removes its manifest entry, and leaves no reconcile cursor. `cotal ext add` and `ext remove` skip linking peers for such an entry instead of failing the install. A package.json that is present but unreadable still fails.
