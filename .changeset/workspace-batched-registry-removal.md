---
"@cotal-ai/workspace": patch
---

`cotal logout`, the account switch in `cotal login`, `cotal down` and `cotal clean all` now remove their registry entries as one batch that scans the registry for pre-hex records once. Before, each removed entry ran its own scan over the whole registry, so removing K entries from a registry of R records read about K × R record files. The removed entries and the pointer outcome are unchanged, also when a removal fails partway through the batch or a concurrent `cotal use` moves the pointer during it.
