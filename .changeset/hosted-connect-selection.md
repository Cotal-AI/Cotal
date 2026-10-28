---
"@cotal-ai/connector-core": patch
---

`handleGatewayRequest` accepts `selection`, so a hosted gateway's `cotal_connect` can take the channels, role and capabilities an agent asks for. The `cotal_connect` description now tells the agent to ask for what it already knows it needs in that first call.
