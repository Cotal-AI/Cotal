---
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
"@cotal-ai/web": patch
---

`cotal down --dry-run` in a folder with no stack now refuses with `TARGET_NOT_FOUND`, exit 2, and says there is no stack at the folder's root to preview. A root with no `.cotal/` directory, or with no stack registered at it, counts as no stack. It used to refuse with `CONFLICT` and say the local records could not be inspected consistently, which suggested damaged state in a folder that simply held none. A symlinked `.cotal/`, an ambiguous registration and unreadable records still refuse with `CONFLICT`. Source comments in the CLI, delivery and web packages that described per-component `cotal down` stops now describe the stops that exist.
