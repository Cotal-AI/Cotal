---
"cotal-ai": patch
---

Daemon setup now reports connection progress on stderr in every output format.
The service-only setup reports its final connection state after waiting, on the first successful
attempt, and when the approval wait expires. JSON output remains one document on stdout.
