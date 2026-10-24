---
"@cotal-ai/core": patch
---

A started endpoint that is reconnecting now says "reconnecting - try again shortly" from every call
that finds it without a connection. Membership, history, members, ACL, lease, control and liveness
calls used to say "endpoint not started" during a self-heal or a manual reconnect, which pointed
the caller at start-up when it only had to wait. A never-started endpoint still says "endpoint not
started".
