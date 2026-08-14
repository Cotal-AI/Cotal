---
"@cotal-ai/core": patch
---

Release the connection `probeConnect` never established.

`probeConnect` is the one connect site whose normal case is a dial that fails — it exists to be
pointed at addresses that may not answer. Against an address that BLACKHOLES (SYN unanswered)
rather than REFUSES (RST) it returned its correct verdict on the deadline and then leaked the
pending socket: one orphaned socket per probe, reclaimed only when the OS SYN timeout fired
minutes later, so the process could not exit. A probe against a non-routable literal returned
`unreachable` at 1006ms against a 1000ms contract and the process still had to be killed at 20s,
while five probes left five socket fds behind and never gave them back.

The teardown could not be added where it appeared to be missing. It is upstream:
`@nats-io/transport-node`'s `NodeTransport.dial()` keeps its socket in a local until the handshake
resolves, so `this.socket` is still undefined when the client's own connect timeout wins its race
and the catch calls `transport.close()` — whose teardown is `this.socket?.destroy()`, a destroy of
nothing. No caller option (`reconnect: false`, `timeout`) reaches the orphan, and a `finally` here
would close a connection we never got.

So the address is now reached on a socket we own before it is handed to `connect()`, and that
socket is destroyed on every exit path. The gate asks only whether TCP completes, never whether
NATS is speaking there, so a TLS-first listener still passes it and goes on to a real connect, and
`connect()` receives the remainder of the budget its own timeout always covered. No verdict
changes: anything past the gate had to complete a handshake for `connect()` to have gotten
anywhere either, and both paths now share one failure classifier, so a locally provable credential
death stays `stale-auth` instead of being downgraded to `unreachable` by a dark address.

Operators see no behaviour change from the `cotal` binary, which force-exits at the end of a
command and so escaped the leak. What was affected is anything embedding `probeConnect` as a
library — including this repo's own suites, one of which had to route around the path entirely to
stop hanging as a gate step.
