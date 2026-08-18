---
"@cotal-ai/core": minor
---

Let a caller hear its own goal's terminal, and say so distinctly when it cannot. `epCallerGrantRows`
returns `{pub, sub}` and documents its `sub` as the per-goal progress row that lets a caller follow
its own goal to terminal, but the `spawn` and `admin` mint branches took `.pub` alone, so a
spawn-capable credential could submit a goal and not hear it: the broker refused the follow, the
manager committed the terminal on time, and the caller reported a timeout about a goal that had
already settled. Both branches now fold `sub` in. Independently, a subscription error in the follow
path was discarded, which made a denied subscription indistinguishable from an empty one; it now
surfaces at once as a distinct refusal naming the subject, stating the goal is unaffected, and
telling the operator not to retry.

Every subscription error is surfaced, not only the permission one: whether the subscription failed
is knowable from the error being present, so narrowing that decision by error class would return
every other class to the silent timeout. What does key on the class is the diagnosis. A broker
refusal reports `permission-denied` and asks for the grant row; any other failure reports
`unavailable`, names the class, and says plainly that changing ACLs is the wrong remedy.
