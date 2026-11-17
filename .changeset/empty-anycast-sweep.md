---
"@cotal-ai/core": patch
---

Avoid creating an anycast scan consumer on spaces with an empty request-record bucket.
The delivery maintenance pass checks the bucket status before enumerating keys. Pending requests
and existing records keep their current maintenance behavior.
