---
"@cotal-ai/cli": patch
---

A long-running command that SIGINT stops now ends cleanly and exits 130, and SIGTERM exits 143.
`console`, `history --follow`, `channel members --follow` and `join` used to exit 0 on a signal, and
the `watch` and `chat` terminal views died by the signal before the chat session closed. The JSON
streams end with reason `interrupted` or `terminated`, `chat --stdio` included.
