---
"@cotal-ai/cli": patch
---

`cotal up` from an unprepared folder, and `cotal up -f`, now refuse `CONFLICT` at once when another program holds the broker address without answering NATS, as the controller stack does, naming the address and the bind error. They used to launch a broker that exited on its bind, probe the other program for about 11 seconds, and end with an unconfirmed outcome.
