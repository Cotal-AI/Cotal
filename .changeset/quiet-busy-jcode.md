---
"@cotal-ai/connector-jcode": patch
---

Reconnect only the private Harness API client when queued-message acknowledgement times out during an attached Jcode TUI's running tool. Preserve the tool when the same bridge reconnects within the bounded window, and name the cause in the terminal diagnostic if recovery fails and ends the seat.
