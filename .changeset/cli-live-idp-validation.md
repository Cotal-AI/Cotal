---
"@cotal-ai/cli": patch
---

Validate controller user-auth inputs before the ordinary recovery lock creates maintenance directories. Compare an explicit IdP with the recorded pin even while the broker is running, and refuse conflicts before journal or member refreshes. Repeat the check under the stack lock before preparation.
