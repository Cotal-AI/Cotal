---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The deprovision teardown now purges a retired lifecycle's durable membership rows on its concrete read channels, through one exact-key grant per channel on the target-pinned deprovisioner credential. Rows on wildcard-covered or unnamed channels, same-alias successors and other principals are retained.
