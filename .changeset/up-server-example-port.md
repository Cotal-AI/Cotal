---
"@cotal-ai/cli": patch
---

`up --server` with an IPv6 address, embedded credentials, or a path refused with the example `--server nats://127.0.0.1:4222`, so pasting it moved the stack to port 4222 and dropped `tls://`. The example now keeps the scheme and port given, such as `--server nats://127.0.0.1:29888`.
