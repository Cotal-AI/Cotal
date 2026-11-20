---
"@cotal-ai/cli": patch
---

When `cotal up` cannot bind a broker address that nothing listens on, its refusal now counts only connections on the address's own host or a wildcard. A connection elsewhere on the machine that happens to share the port number no longer turns a TIME-WAIT into "an open connection's local end holds its port", so the next step stays "wait up to a minute".
