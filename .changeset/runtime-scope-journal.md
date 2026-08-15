---
"@cotal-ai/lang": minor
---

Journal concurrency scopes, so a replayed `race` cannot resolve a different arm.

`parallel`, `race` and `fanOut` pushed a key frame, allocated an occurrence, and recorded nothing.
`race` was a bare `Promise.race`, so its winner existed only in the event loop: when both arms
settled before the cancellation reached the loser, the journal held two successful branches and
nothing saying which had won, and a replayed run could take the other path and reach a step that
was never recorded. That is a durable choice decided by scheduling, which is the one thing this
language exists to make unwritable.

Each scope now appends an entry of its own kind, keyed like any other step. `race` records the
winning branch key AND its value — the index alone would let an edit to an arm's returned
expression resume as the new value with no divergence — together with the losers it owes a
cancellation and whether that intent has been discharged, because a journal write cancels nothing
by itself. `parallel` records its branch keys and no selected winner, which is exactly why an array
index is a lint there and an error for `race`. A settled scope replays from its own entry and
enters no branch, accounting for its subtree so a migration does not read decided branches as
removed steps, and settling any loser still pending as cancelled. A re-entered scope resolves by
the earliest recorded branch clock rather than by whichever promise the event loop wakes first.
