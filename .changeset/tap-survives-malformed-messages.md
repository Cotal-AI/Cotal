---
"@cotal-ai/core": patch
---

One malformed message no longer stops the observer feed behind `cotal console` and `cotal history --follow`. The tap drops a message whose parts cannot be read, as history already does. A handler that throws is reported as an endpoint error, and the feed keeps reading later messages.
