---
"@cotal-ai/connector-core": patch
---

Export a typed `submitFeedback` helper for hosts that need the same feedback intake contract as the MCP tool. The tool now uses that helper without changing its keyed and keyless routing, request fields, email requirement, or result text.
