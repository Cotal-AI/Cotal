---
"@cotal-ai/core": patch
"@cotal-ai/connector-claude-code": patch
"cotal-ai": patch
---

A session on a websocket mesh now reconnects after its connection dies without a reset, such as during a laptop sleep, and `cotal_disconnect` no longer hangs while the mesh is unreachable. When the ping check finds such a connection stale, the client stops waiting for the unanswered closing handshake after 5 seconds and reconnects. A failed websocket dial now names the URL it dialed, whether the socket had opened, how long it had been trying or open, and any reason given, where it used to say only `ConnectionError`. A Claude Code disconnect waits at most 3 seconds for the event plane before it stops the connection.
