---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

Scope the artifact fetch gate, and make attach refusals and lifetimes honest.

The fetch gate no longer branches on a global blob probe. `FetchGateDeps.blobExists` is
still there but is now reachable only after a new scope-local `scopeRecord(digest, scope)`
says the digest is in scope, so `unknown digest` and `not yet attached` can no longer be
told apart on whether bytes exist somewhere in the space. `unknown digest` becomes the
collapsed, scope-scoped name and `expired` — previously declared and returned by no path —
becomes reachable from scope-local terminal state.

`confirmAttach` collapses every distinction available before a caller proves it published
the entry into one refusal, checked first. `ATTACH_REFUSAL.entryNotFound` is removed: a
separate "no such stream entry" let any control-rail principal probe the chat stream's head
position without read access to any channel. The accepted cost is that a legitimate caller
whose entry was purged now receives the collapsed refusal.

New: `ensureArtifactIndexStores`, called by both space setup and restore so the two lists
cannot diverge — restore previously recreated four of the five and threw at its own
assertion. New: `putAttachmentIfAbsent`, which makes attach lifetime-neutral in code rather
than in a comment, so a repeat confirm cannot refresh the timestamp retention is aged from.

BREAKING for anyone constructing `FetchGateDeps` by hand or matching on
`ATTACH_REFUSAL.entryNotFound`.
