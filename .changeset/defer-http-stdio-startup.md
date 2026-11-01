---
"@cotal-ai/connector-core": patch
---

Load the MCP SDK's HTTP transport when the HTTP gateway is used, keeping its initialization out of stdio-only startup. Preserve HTTP gateway and fetch-on-use behavior.
