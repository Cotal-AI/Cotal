---
"@cotal-ai/core": patch
---

The broker probe gates a plaintext dial on the server's INFO greeting on a socket it owns, so a broker that completes the TCP handshake but greets after the budget no longer leaves an orphaned socket that keeps the process alive; a TLS-required or websocket dial keeps the handshake-only gate (#2156).
