---
"cotal-ai": patch
---

Keep the Windows daemon responsive while its native service ownership is verified.

Run the exact recorded-service checks off the serving event loop once and reuse their result for generation activation. Pending or failed verification does not grant activation authority.
