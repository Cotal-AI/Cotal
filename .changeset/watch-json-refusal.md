---
"@cotal-ai/cli": patch
---

`cotal watch --json` now names the resolved space and the refusal's own reason in its `error` record, as the plain form does. `watch --json --view dms` on an authenticated space used to report only `requestedSpace: null` and a generic sentence. The plain refusal also begins with its `Mesh:` line.
