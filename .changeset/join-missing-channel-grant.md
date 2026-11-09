---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

`cotal join` now names a missing channel grant instead of the delivery daemon.

A credential from `cotal auth mint <name> --provision` grants no channel unless the mint carries `--allow-subscribe`. Joining a channel that credential does not grant was refused with the same delivery-daemon sentence as an unbound responder. The refusal now says the credential's history grant is no channel, or names the channels it does grant, and tells you to mint one with `--allow-subscribe` for the channel. A credential that grants the channel still names the delivery daemon.
