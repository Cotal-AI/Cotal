---
"@cotal-ai/cli": patch
---

attach: own the keyboard whenever there is no session. Keystrokes typed at a terminal whose link
has died are read and dropped instead of buffered, so nothing an operator types at a frozen screen
is delivered to the agent by a reconnect they did not know had happened, Ctrl-C included. That now
covers every gap in the loop: the waits, the attempts, the hand-back of a session that faulted on a
link that is still up, and the first establishment, so a key struck before the very first attach
comes up does not arrive at the agent when it does. The detach key is read across all of them, and
a press that lands while a session is opening ends the attach rather than being swallowed by the
handoff to that session's own reader. With stdin a pipe the old behaviour is kept on purpose: a
script's input is buffered and delivered when the session opens, and `--no-reconnect` keeps the
single-session behaviour everywhere.
