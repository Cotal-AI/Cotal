---
"@cotal-ai/connector-core": patch
---

A `cotal_dm` reply to a peer that messaged you and has no roster row, such as a one-shot `cotal send`, is now stored under that sender's id in the space's DM history instead of failing with `no peer "<name>" in space "<space>"`. The sender is matched by the exact id on the message you hold, or by its display name while the presence view is current. A name that two such senders share is refused with their ids. The receipt reads `recipient had no roster row at send` and says the DM may never reach an inbox, since a one-shot send has already exited. An operator's DM view, such as the dashboard's Direct messages lens, shows the reply.
