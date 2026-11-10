---
"@cotal-ai/connector-opencode": patch
---

OpenCode 2.x seats now publish the AG-UI event plane, so launches with events on, the default, no longer exit on OpenCode 2.x.

The 2.x connector reads the session it launched through OpenCode's message list and publishes the same events as 1.x: run boundaries, assistant text, and each tool call's start and end, with tool arguments and results withheld and reasoning off. A turn's end and its outcome come from the record OpenCode 2.x writes into the session, so a failed turn ends its run with `RUN_ERROR` and an interrupted one as an ordinary end. A registration that requires events now arms on 2.x as well.
