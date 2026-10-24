---
"@cotal-ai/cli": patch
---

`cotal up --server <url>` on a stopped stack recorded at another address now names that address when another program holds it, with any process of this account that listens there, and says to stop it before a bare `cotal up`, since no command moves a stack that ran to another address. Before, it sent the operator to a bare `cotal up` that refused for the same held port.
