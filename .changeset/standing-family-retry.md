---
"@cotal-ai/manager": patch
---

Signerless managers retry a rejected standing credential family before the next regular renewal tick.

A failed candidate now schedules another pass within one second, so a transient rejection does not consume the remaining credential lifetime. The retry keeps the existing account, identity and broker-preflight checks and stops with the manager's renewal timer. Overlapping run-credential renewals share one issuance and adoption pass, so fast standing retries do not race a slow run renewal.
