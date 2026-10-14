---
"@cotal-ai/connector-jcode": patch
---

A Jcode seat now passes its pre-join readiness proof when Jcode calls `cotal_orientation` through its deferred `mcp_call` tool. The proof matched only the completed tool's name, which is `mcp_call` on that path, so both readiness turns missed it and the seat exited without joining. The host now reads the call's streamed arguments and counts an `mcp_call` only when it names server `cotal` and tool `cotal_orientation`, and only for the `mcp_call` completion of that same call: a completion under another name, or a later call that reuses its id, does not count. An orientation call that fails or returns an MCP error result no longer counts on either path.
