---
"@cotal-ai/auth": patch
---

Auth cleanup stops rereading expired service receipts on every pass. It continues to check new and live receipts, and hosted deployments can set the cleanup interval with `nativeIssuancePruneMs`.
