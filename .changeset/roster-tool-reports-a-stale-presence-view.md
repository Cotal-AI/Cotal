---
"@cotal-ai/connector-core": patch
"@cotal-ai/workspace": patch
---

`cotal_roster` no longer presents a non-current presence view as live state. A roster is a
liveness claim only while the observer's presence watch is current: when the whole bucket has
been silent past the liveness window, every peer ages out together and the roster reads
all-offline, which says the view went stale, not that the mesh emptied inside one TTL. The tool
rendered that indistinguishably from a healthy roster, so `Present in "<space>" (N)` over N
offline rows was read as fact — on a live mesh a reader concluded a peer had dropped off while
that peer was mid-turn, and acted on it. `cotal ps` already refuses a liveness word in the same
situation and prints `mesh unknown` with the reason; this brings the agent-facing tool to the
same standard. A `current` view is unchanged. A `stale` or `unpopulated` view now heads the
output with `Last-known roster for "<space>" (N) - presence view is stale` (or `is not yet
populated`) and marks the statuses last-known rather than current. The rows are still listed,
because offline peers stay in the roster for observability (SPEC §6) and the failure being
fixed is the claim made about them, not their presence in the list.

`MeshAgent.presenceView()` is added so the connector can reach the endpoint's existing
`presenceView()`; it was the only presence signal the facade did not expose, which is why the
tool could not consult it. No wire, schema, or presence-record change: this is what the tool
says about a view it could already have read.
