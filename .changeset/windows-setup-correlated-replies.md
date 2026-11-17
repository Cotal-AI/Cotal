---
"cotal-ai": patch
---

Windows setup now waits for the matching service reply when recovering from a timed-out preparation request.

The installer keeps partial replies across reads and discards only replies to requests that timed out. Malformed or unknown replies refuse the connection, and a missing abort reply remains unconfirmed. This also works when setup talks to an older installed runtime.
