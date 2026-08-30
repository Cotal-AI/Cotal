---
"@cotal-ai/core": patch
"@cotal-ai/web": patch
---

A stalled presence-KV watch no longer sweeps every peer offline. Whole-bucket silence past TTL marks the observer view stale (last-known roster kept); the dashboard surfaces that on the existing stale pill and debounces the recovery replay so the online sidebar does not empty.
