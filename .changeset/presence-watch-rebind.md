---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

Rebind a presence watch that goes silent under a live connection, and stop `cotal ps` from printing a liveness verdict while the manager's own presence view is stale.

On netcup on 2026-09-09 the presence stream was deleted and recreated while the manager kept its
connection. Its ordered consumer re-created itself from the old cursor against a stream whose
sequence had restarted, the broker kept sending it idle heartbeats, and nothing ever re-created the
watch. The manager's roster froze at the pre-recreation snapshot for hours: `cotal ps` printed
`mesh offline` for every seat older than the freeze and `not in roster` for every seat younger,
while a fresh observer saw all of them heartbeating. The lane watchdog stopped a working
orchestrator twice on that reading.

The endpoint's sweep already refused to age peers out while the whole bucket was silent and marked
the view stale; that was the right verdict for a held link and the wrong end state for a dead
consumer. When the view is stale and the transport is up, the endpoint now stops the old watch and
binds a new one from the bucket's current state, once per liveness window, and reports the rebind
as a warning that names the silent interval. The per-peer age-out also requires that the watch
delivered for a full window after the peer's last heartbeat, so an observer's own deafness no longer
emits one offline verdict per peer on the tick before the whole-bucket gate trips.

Each `ps` row now carries the manager's presence-view state (`meshView`: `current`, `stale`, or
`unpopulated`), and the CLI prints `mesh unknown` with the reason instead of `mesh offline` or
`not in roster` whenever that state is not `current`. Rows from an older manager carry no field and
render as before.
