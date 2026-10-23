---
"@cotal-ai/auth": patch
---

The sealed auth-ledger, obligation and manager goal-index scans run one shared consumer lifecycle (pre-clean, forced create, bind-verify, drain, delete) instead of three copies. The goal-index scan now refuses a failed consumer create as `unavailable` naming its stream, as the other two scans already did, where it used to surface the raw JetStream error. Every scan refuses a delivered subject with an empty token.
