---
"@cotal-ai/cli": patch
---

The `up-multi-space-render` live smoke no longer imports `tmpdir` from `node:os`. The import was never used: the suite's scratch comes from `makeScratch`, which checks its ancestry. Shipped behaviour is unchanged.
