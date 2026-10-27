---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal down` attributes a recorded pid through the component's own command check, and it does that at one point. A record whose identity pin names another process start is refused and kept, for the delivery daemon and the manager alike. A record with no pin whose live command is not that component's is removed without a signal, and the two stops print one line for it.
