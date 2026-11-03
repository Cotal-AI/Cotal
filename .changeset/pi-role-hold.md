---
"@cotal-ai/pi": patch
---

A pi seat now keeps the deliveries of a running turn in flight until the turn commits them, as the other connectors do. Before, a role request's ack wait could run out while the first holder was still working on it, and the broker handed the same request to a second holder of the role, so both worked on it. The batch is renewed for the length of the turn and released when its turn commits. When the in-flight ceiling is reached, a new batch waits instead of going out unprotected.
