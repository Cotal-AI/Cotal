---
"@cotal-ai/connector-core": patch
---

The block that carries peer messages into a turn now names the order of operations rather than only
the reply verbs: do the work with your own tools, verify it, then reply, and never report an action
that was not performed. A delivered peer message is frequently a work order, and its tail arrives at
the moment the model chooses what to do next, so a reply-only tail reads as an invitation to answer
instead of to act.
