---
"@cotal-ai/cli": patch
---

`cotal backup` on a broker that hosts several spaces refuses as `CONFLICT` (exit 2) and names the spaces, before any cut preparation. It used to report that preparation did not establish an eligible stopped preserved cut.
