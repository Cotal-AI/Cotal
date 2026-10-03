---
"@cotal-ai/manager": patch
---

Report the manager plane unbound while its service connection reconnects

The manager's liveness responder answered `bound` whenever its service connection was not closed.
That connection reconnects without limit, so after a drop it stays open while the broker holds none
of its service subscriptions, and a probe answered on the separate supervisor connection said
`bound` for a manager that could not be reached. The responder now also requires the service
connection to be connected, so a peer is told `unbound` until the client has reconnected and
subscribed again.
