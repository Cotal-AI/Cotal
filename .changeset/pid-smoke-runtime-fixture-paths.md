---
"@cotal-ai/workspace": patch
---

The pid contract smoke now writes its manager pidfile, delivery pidfile and delivery-aware marker where a current start writes them, derived from `MANAGER_PIDFILE`, `DELIVERY_PIDFILE` and `MANAGER_DELIVERY_AWARE_MARKER` for the space the root resolves to. It used to spell the pre-segmentation names, so every manager and delivery caller cell reached its record only through the legacy read admission and would have failed for the wrong reason once that admission narrowed.
