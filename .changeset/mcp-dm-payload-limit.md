---
"@cotal-ai/connector-core": patch
---

`cotal_dm` now explains a DM the broker is too small for. It used to pass on the client's bare `'payload' max_payload size exceeded`; it now gives the broker's message limit in bytes, says nothing was sent, and tells the sender to shorten the message or split it across several DMs. A publish whose acknowledgement times out is still reported as an unknown send outcome.
