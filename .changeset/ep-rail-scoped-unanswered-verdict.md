---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/runtime": minor
"@cotal-ai/connector-core": minor
---

Scope an unanswered endpoint verdict to the rail the request rode

A CLI whose caller carries an issued generation rides the versioned `ep.v1` rail. SPEC 13.15 makes
that rail a separate subject space from the legacy `ep` rail and requires an endpoint to serve
both, so a manager built before the versioned rail serves `ep` alone and never receives the
request. The describe waited out its whole budget and every hosted `cotal run` verb reported that
no manager answered on the endpoint rails, asked whether one was running, and offered `--local`,
against a manager that was up, on the roster and answering `cotal ps` throughout. `--local` drives
the run from the calling process and names the caller as the run's answerer, so an operator who
took the suggestion would submit an answer under the wrong identity.

The unanswered marker now carries the `ep` plane the request was published on, and `describe`
names it in its own refusal. `cotal ps` and the other manager verbs state the reachability verdict
against that rail instead of against the mesh, and say what silence on a versioned rail does not
establish. `cotal run`'s hosted verbs do the same and drop both the question and the `--local`
suggestion there, since neither follows from what was observed. On the legacy rail every message is
unchanged: there is no second rail its silence could be hiding a manager on.

No fallback describe is issued on the other rail. A caller holds broker rows for its own rail only,
so the request would be refused at publish rather than answered.
