---
"@cotal-ai/core": minor
---

Size artifact transfer chunks against the broker that is actually there.

A broker's maximum message size is configuration, not a constant, and the space around a payload
depends on who is sending it: the caller's name, the upload's identifier, and a counter that gets
one character wider every time it passes a power of ten. Sizing a transfer once, or against a
figure measured on somebody else's machine, produces a limit that is wrong for a different sender
and can turn wrong partway through a transfer that started out fine.

Chunk sizes are now derived per call from the real size of the real message about to be sent. The
caller hands over a function that builds its own outgoing bytes; this measures what that actually
produces and finds the largest payload that fits. It never estimates and never keeps a safety
margin — a transfer fills the available space on every call, so a margin would be throughput given
away on every chunk of every file.

Requests and replies are measured separately, because they are not the same shape. On a small
broker the difference is stark enough that a setting which leaves no room at all for an upload
still has room for a download.

Below some broker size, no payload fits at all. Left alone, that produces the worst possible
failure: a transfer that shrinks toward zero, reports success on every individual step, and never
finishes. Instead it now refuses, by name, saying which broker limit and which minimum size are in
conflict. For uploads that refusal happens before anything is sent, because a message too large for
the broker is rejected by the sender's own client — the server never sees it and cannot answer it,
so there is no reply in which to explain the problem.

Proved against real brokers configured below each limit rather than against a stand-in number,
since the behaviour under test is what a broker and its client will genuinely accept.
