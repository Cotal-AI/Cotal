---
"@cotal-ai/workspace": patch
---

The terminal app can open a managed agent's live terminal in its middle column and type into it.

`openTerminalSession()` from `@cotal-ai/workspace/attach` opens one attach session for a caller that draws the terminal itself. It locates and pins the seat as `attachSeat()` does, honors `expectedTarget`, touches no process terminal, does not reconnect, and returns every refusal as a message. Its `close()` hands the session back to the manager.
