---
"@cotal-ai/manager": patch
---

`cotal supervise --roster` now refuses a roster key it does not know, in an entry or beside `agents:`, and names it before the manager starts. It used to ignore such a key, so a misspelling such as `share_tools: []` shared every declared MCP server and `cdw: services/api` ran the agent in the workspace root.
