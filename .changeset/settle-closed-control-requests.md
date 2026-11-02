---
"@cotal-ai/core": patch
---

Settle pending named-reply control, delivery and delivery-admin requests when their connection closes instead of leaving their promises pending after the reply subscription disappears. Interrupted liveness probes return unknown. Keep native reply subjects, timeout and no-responder handling, and do not replay requests on a replacement connection.
