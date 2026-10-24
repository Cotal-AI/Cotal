---
"@cotal-ai/cli": patch
---

`cotal up` now refuses an IPv6 address in `--server` or `--host`, such as `nats://[::1]:4222`, with `USAGE_INVALID` before anything starts. The stack's own clients cannot reach a broker there. With `--server` alone it used to start a broker on 127.0.0.1, report an unconfirmed outcome and leave that broker running. With `--host` it started a broker on the IPv6 address whose delivery daemon or manager then failed.
