---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Reconcile a POSIX installation after a manual upgrade without stopping its standalone Manager or seats.

Authenticate the Manager and seat inventory, then reconcile connectors in a separate installation-and-release prefix while retaining the previous prefix at its original paths. Windows, source checkouts and version-changing admission are unchanged.
