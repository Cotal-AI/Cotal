---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

A read whose recorded broker answers and refuses the connection now keeps its registration when
another registered space names that same address, and refuses `CONFLICT`, exit 2, naming the space
that holds the address, the `cotal space forget <space>` that frees it and the
`cotal up --server <url>` that moves this one. `cotal status` reports that space as `address held`.
The rejection used to count as a stale record and delete it, which left the folder naming no space,
so nothing there said which space its commands meant.
