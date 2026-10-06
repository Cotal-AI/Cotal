---
"@cotal-ai/core": patch
---

A `liveKvEntries` scan whose consumer nats.js rebuilt no longer retries the delete twenty times and swallows every error. The cleanup now waits until the broker has answered every create the rebuilds sent, then sends one delete for each consumer the scan named, newest first, so a successor whose create was still unanswered when the next rebuild fired, or when the scan ended, is no longer left on the broker. A not-found delete counts as gone. A refused delete, from a profile without `CONSUMER.DELETE`, ends cleanup and leaves the consumers to the broker's inactive threshold. A create that got no reply from the broker before a timeout or a closed connection, whose delete then answers not-found, is reported, because it can still land. Any other delete failure is now thrown, for a scan that was rebuilt or not, instead of being swallowed. A cleanup failure never replaces the scan's own error, its cancellation reason or `IncompleteKvScan`.
