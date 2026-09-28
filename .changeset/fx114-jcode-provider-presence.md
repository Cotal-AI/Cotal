---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

The jcode connector now reports the provider route serving a seat's model to presence, and `cotal ps --wide`/`--json` surface it as `provider`.
