---
"@cotal-ai/auth": patch
---

Extend the auth-callout connect-load harness: run several callout service processes behind the existing queue group with `--callouts N`, so the service's horizontal scaling can be measured rather than assumed. Fix two harness faults found by the message-rate scenario: the load child wrote its result to a pipe and then exited, which truncated large results, and the scenario sampled a delivery latency for every delivery, which with fan-out is millions per run. The message-rate scenario now exchanges on the channel subjects an agent grant actually carries instead of a literal subject the broker refuses.
