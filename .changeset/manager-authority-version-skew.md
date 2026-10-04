---
"@cotal-ai/auth": patch
---

A remote manager whose authority request is refused by an older host, for a field that host's auth service does not know, now reports version skew. After the host's reason, the refusal names the manager's Cotal version and the field, and says the manager needs a host at that version or later. This covers every manager-authority request, including the all-duty renewal and hosted-run admission. The field is still sent.
