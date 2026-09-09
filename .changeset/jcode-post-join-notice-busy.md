---
"@cotal-ai/connector-jcode": patch
---

Keep a jcode seat alive when its post-join notice is refused. A session resumed from a transcript
that ends mid-turn is busy the moment it joins, the server refuses the notice's context message
while it is, and the no-reply path reported that refusal by throwing into the startup catch, which
killed an already-joined seat and discarded its accumulated session. The notice is now best-effort
and its refusal is recorded in the connector log.
