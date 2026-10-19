---
"@cotal-ai/connector-core": patch
---

`searchDocs` now returns no hits for a limit of zero or less. It used to add the best match before checking the limit, so a limit of `0` or `-1` returned one section.
