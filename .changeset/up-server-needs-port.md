---
"@cotal-ai/cli": patch
---

`cotal up --server <url>` now refuses a URL with no port, such as `nats://127.0.0.1`, with `USAGE_INVALID` before anything is started or written, and its next step names the port to add. It used to start the stack on the default port 4222 and record the broker address without a port.
