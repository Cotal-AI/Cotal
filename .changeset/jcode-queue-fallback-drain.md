---
"@cotal-ai/connector-jcode": patch
"@cotal-ai/connector-core": patch
---

A Jcode seat whose soft interrupts time out now keeps consuming its queue, and stops reporting itself healthy while it is not.

Peer messages that arrive while a Jcode session is busy are handed to it mid-turn. When that handoff got no reply, nothing else ever looked at the queue: it was served only by a new message arriving or the session going idle, and on a busy seat neither has to happen. Messages piled up behind a seat that was working normally and answering direct questions, and the seat was indistinguishable from a wedged one. Measured on a live seat: 27 messages held for 13.8 hours.

A seat now serves its own queue on a schedule rather than waiting for an event. If the mid-turn handoff stops answering, the queued messages are delivered as an ordinary turn instead, which needs no reply from it, so they arrive late rather than never. Nothing is dropped and nothing is delivered twice.

`cotal_connection_status` also stops calling such a seat `ready`. A bound session with a live transport whose queued messages have made no progress for ten minutes now reports `stalled`, alongside how long the queue has gone without committing anything, and `cotal_reconnect` says plainly when rebuilding the connection did not deliver them, instead of answering with a bare success over an untouched queue.
