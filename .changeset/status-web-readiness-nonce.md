---
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
---

`cotal status --components` now presents the dashboard's readiness nonce from `web.session` when it probes `/api/meta`, so a live dashboard at its recorded address grades `web serving`. The probe used to ask anonymously, the dashboard's auth gate refused it with 401, and the row could only read `not-serving · http identity mismatch`.
