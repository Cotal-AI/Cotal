---
"@cotal-ai/connector-core": patch
---

The docs gate now fails when a page quotes an operator string that no shipped source emits. A source change that renamed a printed line used to leave the old wording in `docs/`, and every docs check still passed, so `cotal_docs` served guidance an operator could not grep for. `docs/cli.md` now writes the rail in the unanswered-manager verdict as a placeholder, `no manager answered on the <rail> rail`.
