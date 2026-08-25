---
"@cotal-ai/cli": patch
---

The control command family (`ps`, `stop`, `attach`, and the detached-session release) dials
through `dialerFor`, so it works against a websocket broker (`wss://…`) instead of refusing
with "'servers' node client doesn't support websockets, use the 'wsconnect' function
instead" while `send` and foreground `spawn` — already routed through the dialer — worked.
