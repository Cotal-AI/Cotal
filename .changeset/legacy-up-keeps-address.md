---
"@cotal-ai/cli": patch
---

A bare `cotal up` on a stopped legacy root now starts it at the address its last start used, and in
open mode when that start was open, and says so. Before, a legacy `down` dropped the registration
that kept the address, so the next bare `up` started on 127.0.0.1:4222 in static auth. After
`clean all` on a root deployed with `up -f`, a bare `up` that would start another address, mode or
space refuses and names `cotal up -f <manifest>`.
