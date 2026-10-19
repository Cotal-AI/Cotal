---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-opencode": patch
"@cotal-ai/connector-codex": patch
---

`cotal models` now reads the OpenCode and Codex catalogs from the binary a managed launch runs: the operator's `COTAL_OPENCODE_BIN` or `COTAL_CODEX_BIN` pin when set, otherwise the path the manager resolved at boot. The catalog used to run the harness by bare name on the manager's PATH at request time, so a binary added ahead on PATH after boot answered the catalog and its version check while a spawn ran the boot binary, and a 2.x OpenCode placed there refused the catalog for a 1.x harness. `ModelCatalogOpts` gains `resolvedBinaries`, and the manager passes the boot-resolved paths it already gives a launch.
