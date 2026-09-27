---
"@cotal-ai/web": patch
---

Move the two header reads that compute the announced-body fact below the auth gate, so the pre-gate prefix stays a parse and nothing else; refusal bytes and the no-body guard are unchanged (#2178)
