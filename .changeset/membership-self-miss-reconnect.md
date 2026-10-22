---
"@cotal-ai/core": patch
---

The membership feed no longer warns "CONNZ sweep omitted our own rw connection" when the sweep ran while its own data connection was reconnecting. Adopting a renewed rw credential reconnects that connection in place, and a sweep inside the reconnect cannot see it. That sweep still keeps the last membership, and the connection's return polls again. The warning remains for a sweep that misses the connection while it is up.
