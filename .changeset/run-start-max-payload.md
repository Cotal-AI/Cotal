---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

A hosted `cotal run start` of a program larger than the broker's message limit is now refused `UNSUPPORTED`, naming the program's size and the limit, with a next step. Before, it was reported as an unconfirmed outcome with exit 3, although nothing was sent and no run was created.
