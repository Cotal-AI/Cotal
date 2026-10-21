---
"cotal-ai": minor
"@cotal-ai/cli": minor
---

`cotal chat` answers by principal. `/reply` answers the latest direct message or role task the session received: it addresses the sender's principal and quotes the message id, with no name lookup, and after the reply is stored the recipient stays that principal. A transcript sender, a `/who` row, an `/inbox` or `/history` line and a recipient choice show the principal beside a display name that another principal in the session carries; `--plain` names those principals once when a name becomes shared. A typed DM target that parses as a principal `<owner>.<actor>`, from `@` or a `--stdio` `dm`, goes to that principal whether or not it is present or was heard from, and is never matched against display names, so no display name can capture it. A peer whose display name parses as a principal is reached by its principal or `/reply`, and typing the session's own principal refuses with `USAGE_INVALID`. A display name that more than one principal carries among the present peers and the heard senders now refuses and lists them, where before a present peer with that name took the message.
