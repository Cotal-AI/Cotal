---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal up` on a broker port that nothing listens on, but that a connection's local end still holds,
such as one in TIME-WAIT after an outbound connection closed, now says so on Linux. It used to say
another process holds the address and tell you to stop the process listening there. For TIME-WAIT
its next step is to wait up to a minute and run `cotal up` again, or to pick another address.
