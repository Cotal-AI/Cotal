---
"@cotal-ai/connector-codex": patch
---

Keep automatically answered native user-input requests (`item/tool/requestUserInput`) from disarming workflow turn completion. A completed Codex turn now yields done after this request without requiring a later command or MCP item. Explicit blocked and handoff yields remain unchanged.
