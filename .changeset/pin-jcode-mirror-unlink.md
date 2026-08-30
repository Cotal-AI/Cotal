---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-core": patch
---

Jcode credential mirroring pins copy, mkdir, and unlink through one Linux `/dev/fd` parent walk, and names a refusal when that traversal is missing.
