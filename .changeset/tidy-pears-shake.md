---
"@cotal-ai/cli": patch
---

attach: own the keyboard while a reconnect has no session. Keystrokes typed at a terminal whose
link has died are read and dropped instead of buffered, so nothing an operator types at a frozen
screen is delivered to the agent by a reconnect they did not know had happened, Ctrl-C included.
The detach key now works for the whole time the loop runs, attempts as well as waits: pressing it
while a session is being established ends the attach there, and a session that lands behind the
press is handed back to the manager rather than left holding a slot.
