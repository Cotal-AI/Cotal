---
"@cotal-ai/core": patch
---

A stopped endpoint no longer keeps its process alive while a boot channel join or a refused membership close waits to retry. With no delivery daemon running, `cotal mcp` and other short-lived clients could take up to 30 seconds to exit after a stop. Stopping now ends that wait, so the process exits as soon as its connection closes.
