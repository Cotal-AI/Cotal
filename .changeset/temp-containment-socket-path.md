---
"@cotal-ai/connector-core": patch
---

A control socket path longer than the kernel's `sun_path` limit is refused at construction with a message naming the path, its byte length, the limit and the temp root budget, instead of surfacing as a bare `EINVAL` from the bind.
