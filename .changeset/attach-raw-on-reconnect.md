---
"@cotal-ai/cli": patch
---

`cotal attach` now puts the terminal in raw mode when it starts reconnecting. If the link died after `attached to` printed but before the first session was ready, the terminal stayed cooked for the whole reconnect, so the detach key echoed as `^]` and did nothing until a later session opened.
