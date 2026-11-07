---
"@cotal-ai/core": patch
---

Read retained endpoint credential families with the existing complete KV value scan instead of serial per-row requests. Keep family filtering, validation, revoked rows and registration barriers unchanged; interrupted scans refuse rather than returning partial evidence.

Allow the CLI endpoint executor to acknowledge native flow control on its derived auth KV stream only, so large complete value scans do not stall. Other stream/account permissions, instance-pinned writes and credential lifetimes are unchanged.
