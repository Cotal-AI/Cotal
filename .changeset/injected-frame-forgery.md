---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-hermes": minor
---

A peer can no longer forge the framing of an auto-injected message

The block that carries waiting peer messages into a turn interpolated the message body and the
sender name raw, and the Hermes sidecar built the same shape by string concatenation. Both were
forgeable the two ways the inbox reply used to be: a body carrying a newline produced a second item
in the block, reading to the agent as a separate delivered message from a peer that never sent one,
and a sender naming itself with a closing bracket ended the real attribution and opened a forged
one. These frames are auto-injected rather than returned when the agent asks, so the agent never
had a chance to distrust them.

The rule both surfaces now hold is the one the inbox reply already held, and they hold it through
the same code rather than a second convention: a line that begins at column zero is written by the
connector, never by a peer. One message is one line plus indented continuations, with the
attribution inside a single bracket pair. The neutralization moved into a shared module that the
injected block and the inbox reply both render through, so the body, the sender name and role, and
the service and channel labels all pass through one implementation. The Python sidecar carries a
matching module, kept to the same character class on purpose, since a peer that can forge the frame
on either side of the socket has the whole class back.

Two widenings came out of stating the rule positionally rather than by example. The attribution
class now neutralizes the opening bracket as well as the closing one, because stripping only the
closing one still let a name render a bracket pair a reader takes as the innermost attribution. The
injected block's per-item separator is the bracketed attribution the inbox reply uses, replacing the
bullet, so the text of an injected block changed and the wake-path suites that assert on it were
updated with it.
