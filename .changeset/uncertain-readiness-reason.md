---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Carry the manager's readiness guidance on an `uncertain` goal terminal. The manager built a
diagnosis naming the agent and telling the operator to inspect rather than re-issue, then dropped
it: the terminal committed core's generic "the success signal did not arrive within the readiness
deadline", which reads as a plain failure and teaches a re-issue, and a re-issue after a launch
that actually succeeded mints a duplicate agent. `settleGoalUncertain` now accepts an optional
`reason` the committer supplies, and the manager passes the detail it already constructed; core's
line remains the fallback for a committer that supplies none.
