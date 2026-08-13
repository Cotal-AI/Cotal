---
"@cotal-ai/manager": patch
---

A duplicate-goal loser no longer steals the winner's terminal.

When two same-goalId attempts race, the loser of the create-only `bindGoal` CAS serves the winner's
acceptance and unwinds. That unwind reached the post-accept fallback with `terminalEntered` still
false, so the loser committed a `failed` terminal carrying its own abort message as the outcome.

The loser fails in one CAS round trip while the winner is still minting credentials, spawning a
process and waiting for readiness, so the loser's failure normally lands first. First-terminal-fact
wins, so it becomes durable and the winner's real `succeeded` loses the CAS. The caller reads a
failed goal for an agent that started fine. Two side effects rode along: the loser cleared the
reconcile index entry that would otherwise let a successor settle the goal honestly, and dropped the
winner's cancel path.

The losing attempt now claims the terminal without committing one, the same thing
`onTerminalDeferred` does for a despawn that owns the outcome. It provisioned nothing, so it settles
nothing.

Reproduced before the fix, on a real broker with a real manager and a real agent process, by
capturing a spawn request off the wire and replaying the identical frame. The committed terminal was
`failed` with the loser's abort text. Covered by a new `M8` case in `smoke:manager-spawn-action`,
which carries a positive control asserting the duplicate actually reached the wire, since a replay
that silently never fires would make the whole case vacuously green.

The same claim is applied to the sibling-instance branch (a foreign instance already recorded the
goal index). That line is reasoned by symmetry and is **not** covered: mutation-testing it kills no
check, because the new case races one incarnation. A multi-instance race test would be needed to
prove it.
