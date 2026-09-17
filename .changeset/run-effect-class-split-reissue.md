---
"@cotal-ai/runtime": minor
---

A durable run's unpinned spawn survives the class-queue split instead of dying at it

A run resolves the manager on the class rail and binds the incarnation that answered its describe.
The invoke is a second, independent trip through the same anycast queue, so in a space served by
more than one manager it routinely reaches another member. That member refuses before dispatching
and says so: SPEC 13.2 marks the refusal `not-executed`, meaning the command did not run and no
effect of it exists. The refusal is correct for one command and destructive for a run. Raised as the
effect's own L4000 it ended a durable Lang run at its first `spawn` with no `placement`, consuming
the run id and its journal, and a retry started a fresh run that failed the same way about half the
time.

The manager calls a run performs now re-issue such a refusal rather than returning it. The stale
class handle is dropped, the endpoint is re-described, and the call goes out again, up to a bounded
number of attempts, after which the refusal surfaces unchanged and still states that the command
did not run. This is the licence core's `Endpoint.invokeService` already re-issues on: the marker
together with `not-executed` is the responder's own statement that the re-issue is a first attempt
and not a second, so nothing is duplicated. It covers `spawn`, `turn`, the relay a paused `ask` or
`checkpoint` submits, and the `despawn` a cancelled spawn discharges with.

A handle pinned to one instance is never repaired. It addresses that incarnation by name, so a
refusal from it is that instance answering about itself, and re-resolving onto the class rail would
be the anycast fallback an explicit placement exists to remove.

The repair converges rather than eliminating: the re-issue draws the same queue, so a space of m
managers still splits (m-1)/m of the time per attempt. Nine attempts leave two managers a 1-in-512
residual where the unrepaired refusal was 1-in-2. Removing the residual means addressing one
instance, which the run's caller holds no instance-rail grant for unless its program named a
placement.
