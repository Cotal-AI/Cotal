---
"@cotal-ai/auth": patch
---

Keep unexpected HTTP handler errors in the auth service's server log and return a generic 500 on both listeners. Reject null, array and scalar exchange bodies with a named 400 that counts toward the listener's refusal budget. Preserve the explicit malformed-JSON and oversized-body responses.
