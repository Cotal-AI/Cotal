---
"@cotal-ai/core": minor
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
---

Migrate a run onto edited source: the walk enters a settled scope instead of consuming it, and the
orphan table decides what the edit may drop.

A resume returns a settled `race` from its own entry and marks the whole subtree accounted for. Under
edited source that same short-circuit hides work: an effect the new program no longer reaches never
appears in the orphan set, so a resolved approval inside the winning branch disappears with nothing
raised. The walk now enters the recorded winning branches, runs the ordinary hash and orphan checks
inside them, accounts for decided losers as before, and refuses a scope whose handle was never
journalled rather than consuming what it cannot check.

What the walk found is then judged by effect kind, because a removed step here can have consequences
that outlive it: a live agent, an open conclave, a decision a person made, or a notice its addressee
has not been told are refusals with codes rather than data to ignore. Notices gained a per-run
enumeration so that last rule has something to read.
