---
"cotal-ai": minor
"@cotal-ai/cli": minor
---

`cotal chat` answers by principal. `/reply` answers the latest direct message or role task the session received: it addresses the sender's principal and quotes the message id, with no name lookup, and after the reply is stored the recipient stays that principal. A transcript sender, a `/who` row, an `/inbox` or `/history` line and a recipient choice show the principal beside a display name that another principal in the session carries; `--plain` names those principals once when a name becomes shared. A typed DM target resolves an exact principal first, whether present or heard from, so no display name can capture it. A display name that more than one principal carries among the present peers and the heard senders now refuses and lists them, where before a present peer with that name took the message.
