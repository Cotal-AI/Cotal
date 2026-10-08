---
"@cotal-ai/auth": patch
---

The auth-ledger and records scanners now run every sealed scan through one shared plane-guard helper, `guardedScan`, beside `ScanGuard`. It used to be written out three times: once in the ledger scanner and once in each of the records scanner's obligation and manager goal-index scans. A change to the before-and-after claim check is now made in one place. No behavior changes.
