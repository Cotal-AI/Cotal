---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

A broker-refused manager call no longer claims a cause the broker did not report. It keeps the refused subject, instance and not-executed outcome. On a user-auth mesh a refused ps or slots read adds the documented admin-scope requirement and points to cotal auth grants. Grants, routing and the refusal itself are unchanged.
