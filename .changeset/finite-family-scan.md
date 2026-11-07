---
"@cotal-ai/core": patch
---

Read retained endpoint credential families with the existing complete KV value scan instead of serial per-row requests. Keep family filtering, validation, revoked rows and registration barriers unchanged; interrupted scans refuse rather than returning partial evidence.
