---
"@cotal-ai/connector-core": minor
---

`cotal_inbox` clears only the messages it actually returned, so a recovery read can no longer consume mail it never delivered.

The read is destructive, recovery is when the payload is largest (reconnecting brings a channel-history
replay with it), and a payload can exceed what the host will hand to a model. Composed, the first pull
after a reconnect marked a real direct message read inside a response nobody received. Measured before this change: 200 messages, 463,788 characters, one call, inbox left at zero.

Now one call carries at most a receivable window and acks exactly what it rendered. Direct messages and
role requests take the window ahead of channel traffic, with replayed history last, so first-party mail
is not the thing a backfill crowds out. Whatever does not fit stays buffered, unacked and named in the reply, and comes back on the next call. `peek: true` still clears nothing, and is now bounded too.

A message larger than one whole response is never consumed. It is named in the reply with its sender and
size and left buffered, because a payload that cannot be delivered must not be cleared. The rest of the
buffer flows past it, so one such message wedges nothing else.

Migration: a caller with a large backlog now needs more than one `cotal_inbox` call to empty it, and the
reply says how many messages are still held. Nothing is dropped and no argument changed.
