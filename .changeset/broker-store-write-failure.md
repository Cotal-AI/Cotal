---
"@cotal-ai/cli": patch
---

`status` and `send` now name a broker store that cannot be written. When nats-server could no longer
write its JetStream store, as on a full disk, `status` stayed all green and each `send` reported only
that the message may have been stored; the cause was only in the broker's log. For a broker whose
log is on this machine, `status` now shows a `Store` row with the time, cause and file the running
broker logged, and its first Next stops the stack so space can be freed before `cotal up`. A `send`
whose storage acknowledgement times out after such a failure names it and says the message was
probably not stored; it stays `OPERATION_UNKNOWN`. JSON `status` carries the observation as
`result.store`.
