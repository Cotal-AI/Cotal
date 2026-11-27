---
"@cotal-ai/core": patch
---

Internal refactor: the endpoint's internal parts reach each other through one `EndpointParts` record that the endpoint fills at the end of its constructor, replacing per-call dependency callbacks and the private methods that only forwarded to another part. No behaviour change.
