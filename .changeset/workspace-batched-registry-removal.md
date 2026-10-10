---
"@cotal-ai/workspace": patch
---

`cotal logout`, the account switch in `cotal login`, `cotal down` and `cotal clean all` now remove their registry entries as one batch, so the pre-hex sweep runs once and the current-mesh pointer is read once. Before, each removed entry ran its own sweep over the whole registry and its own pointer read, so removing K entries from a registry of R records read about K × R record files. The removed entries and the pointer outcome are unchanged, also when a removal fails partway through the batch.
