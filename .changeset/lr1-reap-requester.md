---
"@cotal-ai/manager": patch
---

The manager's reap line now says which door stopped a seat and who asked: a requested stop names the authenticated requesting principal (`at u_alice.actor's request`), a self-stop, a recursive reap (naming the parent that left) and a manager shutdown each render their own sentence, and the shutdown teardown — which previously printed no line at all — now logs one line per seat. The former combined `this manager stopped it (despawn or shutdown)` text is gone. Refs #1423
