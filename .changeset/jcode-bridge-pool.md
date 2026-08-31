---
"@cotal-ai/connector-jcode": patch
---

The Jcode MCP bridge entry is written `shared: true`, so the per-seat daemon pools one bridge process and reuses it across sessions. Under `shared: false` every subagent session spawned its own bridge and none stopped before seat teardown, so seats running repeated subagents accumulated bridge processes without bound. Pooling stays inside the seat: the daemon, its home, its socket, and its relay token are all private to the seat.
