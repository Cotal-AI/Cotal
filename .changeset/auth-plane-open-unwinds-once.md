---
"@cotal-ai/auth": patch
---

A failed auth plane open now closes every connection it opened and releases its plane claim, wherever the open fails. A JetStream timeout or error on the remote manager issuer's first request, after the auth admin listener came up, used to leave the authority connections, both scanners and the listener open with the claim still held, so a hosted retry on the same space was refused by the leaked claim. The open now records each resource's close as soon as it opens and unwinds them in reverse from one place.
