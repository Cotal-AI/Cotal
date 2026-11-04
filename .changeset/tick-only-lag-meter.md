---
"@cotal-ai/delivery": patch
---

Remove the unused probe-credit method and unbounded getter from the delivery loop-lag meter. Keep tick-only wall-clock interval accounting and its comparison bound unchanged, with updated comments and regression coverage.
