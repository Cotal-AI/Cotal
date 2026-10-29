---
"@cotal-ai/connector-jcode": patch
---

Keep timed-out soft interrupts reserved during the native busy turn and recognize a late positive reply only for that request on the same connection. This prevents a queued-turn fallback from submitting the same accepted message again. Correlated refusals still use the fallback, unknown outcomes remain owed, and acknowledgements stay tied to successful turn completion.
