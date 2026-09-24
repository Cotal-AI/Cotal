---
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-jcode": patch
---

Keep a jcode seat with events enabled alive through a mesh rebuild window. Previously an event
flush or run close that ran while the endpoint was reconnecting read `max_payload` off a connection
that was not there, and the seat exited 1 with `AG-UI emitter stopped: ... max_payload is only
known while connected`. `AguiEmitterHolder` takes an optional `waitLive` hook that a queued step
awaits before it measures and publishes. The jcode host waits on both the Cotal bind and the raw
transport, so the queued records publish in order once the connection is live, with none dropped or
duplicated. A seat stopped during the outage still exits, and its unpublished records stay in
the journal behind the stored cursor. Every other emitter failure stays terminal. Connectors that do
not pass the hook behave as before. Fixes #1868.
