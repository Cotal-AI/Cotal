---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Applications without a native Cotal connector can serve the gateway tools with `cotal mcp`. The stdio host keeps one local mesh identity until disconnect, uses the existing terminal-seat lifetime on static spaces, and retires that identity on shutdown. Signed-in spaces still require a native or hosted connector.
