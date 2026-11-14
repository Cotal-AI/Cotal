---
"@cotal-ai/connector-jcode": patch
---

Jcode seats launched from a source checkout can finish graceful shutdown without a wrapper killing the host.

Source launches load TypeScript directly in Node instead of using the tsx command-line signal forwarder. Published compiled-host launches are unchanged.
