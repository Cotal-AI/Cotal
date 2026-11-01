---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`cotal up` on a running mesh re-creates the memory-backed presence bucket when a broker restart has lost it, and says so, instead of refusing with `stream not found`. A missing file-backed bucket still refuses.
