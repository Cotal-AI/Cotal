---
"@cotal-ai/auth": patch
---

The ledger scanner, the records scanner and managed-agent enrollment now share one keyed serialization helper instead of three private copies. The two scanners' copies never removed a key, so their module maps kept one entry for every space a process had ever scanned. The shared helper removes a key once its last queued call settles, which the enrollment copy already did. Scans still run one at a time per space, and a scan still runs after an earlier one fails.
