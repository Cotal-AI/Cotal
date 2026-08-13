---
"@cotal-ai/core": minor
---

Let a publisher learn the stream sequence of the message it just sent.

`multicastWithAck` broadcasts exactly as `multicast` does and additionally returns the JetStream
acknowledgement — the sequence number the broker assigned, and whether the write was a duplicate.
`multicast` is unchanged and still returns the message, so nothing that publishes today moves.

The sequence is the only handle that can name a stored message. A message's own id feeds the
broker's write-side duplicate filter; it is not an index, and there is no way to look a message up
by it. So a publisher that later needs to refer to what it wrote — to say "that message, the one I
just sent" to a server-side service — has no way to do so, because the acknowledgement carrying the
sequence was discarded before the caller could see it.

The alternative was to let callers supply the message id, which is a larger and more dangerous
change: it alters what a caller may put on the wire, and an id a caller chooses is an id a caller
can reuse. Returning the sequence changes only what a publisher learns about something it has
already done. It grants no new ability — the value already existed and already crossed the network;
it was simply thrown away.

The acknowledgement is returned beside the message rather than attached to it, because the message
object is the wire shape: a sequence welded onto it would ride along every time that message was
forwarded, quoted, or re-sent.

It is deliberately not added to the direct-message and service-call paths. Nothing needs it there
yet, and an unused API is a cost with no user.
