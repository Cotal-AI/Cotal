---
"@cotal-ai/core": minor
---

`replyRefusedBeforeEffect` no longer reads a self-contradictory reply as a refusal. The
`bind-refused` marker asserts that the command did not run, but the detail carries no outcome of its
own, so a reply could pair the marker with `outcome: "executed"`. The only consumer of this predicate
re-issues a command without the repeat-safe gate, so that contradiction was being resolved by
re-sending a command the same reply said had already run. A present outcome that disagrees with the
marker now wins. An absent outcome is still accepted, because the spec permits omitting it and
requiring it would stop core repairing splits for responders that do.
