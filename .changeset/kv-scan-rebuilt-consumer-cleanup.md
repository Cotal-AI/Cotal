---
"@cotal-ai/core": patch
---

A `liveKvEntries` scan whose consumer nats.js rebuilt no longer retries the delete twenty times and swallows every error. The cleanup now sends one delete for each consumer the scan named, newest first, so a successor whose create was still unanswered when the next rebuild fired is no longer left on the broker. A not-found delete counts as gone. A refused delete, from a profile without `CONSUMER.DELETE`, ends cleanup and leaves the consumers to the broker's inactive threshold. Any other delete failure is now thrown, for a scan that was rebuilt or not, instead of being swallowed.
