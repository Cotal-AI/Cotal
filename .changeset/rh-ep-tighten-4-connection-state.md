---
"@cotal-ai/core": patch
---

Internal refactor: the endpoint's connection and the handles opened on it (JetStream clients, KV buckets, membership watches, owned connections and pending replies) live in one `ConnectionState` object that the endpoint's internal parts share by reference, replacing per-field getter and setter callbacks. No behaviour change.
