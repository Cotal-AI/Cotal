---
"@cotal-ai/auth": patch
---

Answer a malformed `/service-endpoint-authority` envelope, such as one with an unknown field, with its named `400` again, as documented, rather than the generic `500` meant for unexpected failures.
