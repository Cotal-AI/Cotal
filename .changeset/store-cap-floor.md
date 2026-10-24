---
"@cotal-ai/cli": patch
---

`cotal up --max-file-store 67108864`, the documented minimum, always failed with JetStream error 10047: the space's membership bucket reserves all of it, and nats-server creates each other stream only while one more byte is free. The least accepted cap is now 67108865, a smaller one refuses `USAGE_INVALID` before the broker starts and names it, and the docs state it.
