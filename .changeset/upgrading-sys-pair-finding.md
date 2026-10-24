---
"@cotal-ai/connector-core": patch
---

`docs/UPGRADING.md`, which `cotal_docs` serves, now has a section saying that `cotal doctor auth` reports a missing `membership-observer` or `connection-evictor` credential as a finding, so a space started before that pair existed has one until `cotal down` and `cotal up --rotate-sys`. No behavior changes.
