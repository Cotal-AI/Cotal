---
"@cotal-ai/auth": patch
---

The auth ledger, obligation and manager goal-index scans now run one shared consumer lifecycle: the pre-clean, forced create, bind check, drain and final delete. A manager goal-index scan whose consumer create fails now fails closed as `unavailable` and names its stream and filter, as the other two scans do. It used to surface the raw JetStream error.
