---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

Agent-driven mesh connection control: an agent granted `capabilities: [connection]` can take itself off the mesh and bring itself back, through two new tools.

`cotal_disconnect` announces the departure first, confirmed at the broker, and only then tears the connection down — so a deliberate departure is visible to a supervisor rather than indistinguishable from a crash. If the announcement cannot be confirmed it refuses and stays connected. The cause travels in the presence record, so an observer sees why. `cotal_connect` returns to the same mesh the session was launched against, with the credential source it was launched with: it takes no target, so it can ask for no scope the operator has not granted and can reach no mesh the agent was not already on. It re-reads a stale credential on the way back, which is how access revoked while the agent was away comes back as a refusal rather than as a key that still works. Durable channel membership is kept across the pair, so the delivery backstop replays what was missed.

Three lifecycle defects found by review driving the verbs against a live broker are fixed with them. A connect that failed after the broker had already accepted the transport used to leave that authenticated connection open, unsupervised, while telling the caller it was refused — the rebuild now closes what it opened, and the refusal says `bind-failed` rather than blaming a host that is up and answering. A failed teardown used to report that it had retracted the departure announcement when it had dropped the handle needed to send that retraction, so peers went on seeing an agent as departed while it was still connected; the announcement is drained-then-dropped, and a retraction is claimed only when the broker confirmed one. And credential renewal no longer outlives a deliberate disconnect: its proof-of-record is an authenticated broker preflight, so a "deliberately off" endpoint was still dialling.

Outcomes are a discriminated union rather than a boolean, and a refusal names the condition that failed — including `transition-unconfirmed`, `teardown-failed`, `bind-failed`, `in-flight-request`, and `credential-source-unavailable` (the launcher's credential command or file failed, so nothing was dialled). A connect that comes back with a live transport but only part of its requested read set reports the channels the broker refused instead of claiming clean success.

Also fixes a hang on the request/reply path: `stop()` settled in-flight requests but left request admission open, so a request issued during a stop was accepted and then never settled. Admission now closes at the sweep, and the refusal says the request was never published — safe to retry, unlike a stranded one whose outcome is unknown.

Corrects two false claims in the tool surface: `cotal_leave` said it could not leave your only channel (no such guard exists, and leaving every channel does not make an agent unreachable, since DMs do not travel over channel membership), and the connection verbs are now hidden from ungranted user-mode sessions rather than only from ungranted static-credential ones.
