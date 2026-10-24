---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal space add --server <url>` with no broker answering at that address now says why, with a remedy. It says when nothing takes a connection at the port, and gives the port check as the remedy. When a broker answers at the same host and port under another scheme, such as `nats://` for a `tls://` address, it names that address, says when it has no TLS, and offers it as the next `--server`. It used to say only that no broker answered, with no remedy.
