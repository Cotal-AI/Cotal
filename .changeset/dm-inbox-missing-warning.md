---
"@cotal-ai/core": patch
---

A connected endpoint now warns once when the broker no longer has its own DM inbox, as after a store reset that the client's reconnect rode through. Direct messages to it are not delivered while the inbox is missing, and before this nothing said so. The endpoint keeps checking and receives again if the inbox comes back. `cotal join` prints the warning.
