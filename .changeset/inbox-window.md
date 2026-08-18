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

Focus recall is walked by this session's own mark, and a sender's clock cannot move it. A recalled
item carries the timestamp the sending endpoint stamped, so one peer running ahead, or one writing
whatever it likes, could park the mark in the future and filter every ordinary message after it out
of recall for the rest of the session. Items at or behind the local clock are ordered by timestamp
and move the mark; items ahead of it are handed over once, tracked by id, and never move it, under a
bound whose cost falls on the sender that spends it.

A response that must choose between carrying a message and describing the ones it is not carrying
carries the message. The held-note gives up its names, then its counts, then itself, rather than let
a message that fits in the window go undelivered because a note about an undeliverable one was
riding beside it.

A peer cannot write the reply's own framing. Every byte of a `cotal_inbox` reply is assembled from
text a peer controls, and the reply is structured: a head line, one line per message with its sender
in brackets, then the held-note and any warning. A message carrying newlines was writing that
structure itself, forging a second message line attributed to another named peer, the held-note with
its call-again promise, and the recall warning. A sender name, a service name and a channel label
could each close their own bracket the same way.

A line that begins at column zero is now written by the tool and never by a peer: one message is one
line plus indented continuations, and every peer-controlled field rendered into the frame carries
neither a closing bracket nor any character a line splitter may honour. The neutralization lives in
one helper, so the wake hints the Claude Code, Codex and OpenCode connectors build from a peer name
are covered by the same rule.

The focus recall mark is forgotten whenever the frontier under it changes. It records a position in
one walk over one frontier, and entering or leaving focus replaces that frontier, so a mark left from
an earlier episode was filtering a new episode's messages out of recall whenever they were stamped
behind it.

Migration: a caller with a large backlog now needs more than one `cotal_inbox` call to empty it, and the
reply says how many messages are still held. A multi-line message renders with its continuation lines
indented by two spaces, and a name, service or channel containing `]` or a line separator renders
those as spaces. Nothing is dropped, nothing is truncated, and no argument changed.
