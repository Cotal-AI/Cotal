---
"@cotal-ai/auth": patch
---

Stop counting unpinned manager-caller selection refusals against the public face's refused-exchange budget. When an owner has several live remote managers, or none, the exchange is refused only after its credential verified, so it is not probing. A session that no manager launched carries no manager pin and polls turn-pending this way every 15 seconds, so a host with eight or more such sessions used to keep its shared bucket full, and every other refusal from that host answered 429 instead of its reason. These refusals now always carry their own reason and leave the budget untouched.
