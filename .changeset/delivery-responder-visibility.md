---
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
---

Report an unbound delivery responder instead of a healthy-looking daemon

A delivery daemon whose `ctl.delivery` responder has not bound blocks spawn, retirement and join,
but no operator-facing surface said so. `cotal status` printed `delivery  running (pid N)` off the
pidfile alone, which is the identical line it prints when delivery is fully healthy. The daemon's
own readiness lease already distinguished the two, and `cotal status --components` already read it,
but that pass is opt-in, so an operator watching the ordinary surfaces saw a green control plane
while every lifecycle operation failed. The boot path made the same conflation from the other side:
when the readiness wait elapsed, `cotal up` logged one info line promising that boot durable joins
would reconcile and then reported success, so its caller could not tell a bound responder from an
absent one.

Bare `cotal status` now reads the same readiness lease `--components` reads, and reports the
responder as bound, not bound, or unchecked. An unbound responder names its consequence in the same
line: no spawn, no retirement, no join until it binds. Bare status remains a broad, recovery
oriented diagnostic and still exits 0, and where the lease cannot be read it says the axis was not
checked and points at `--components` rather than implying health.

Readiness is judged against the daemon that is supposed to be serving, not merely against the flag.
A daemon that dies without releasing its lease leaves its `ready` record in the bucket until the
lease TTL expires it, so for that window a restarted or crashed mesh could still report a bound
responder off the previous daemon's record. Both surfaces now compare the lease holder against the
daemon this workspace launched and report a leftover record as not bound, naming it as a dead
daemon's record that clears on its own. Where the holder genuinely cannot be known, such as an
adopted daemon this process did not start, the holder is not checked and behaviour is unchanged.

`cotal up` either binds the responder or states that it did not and what that prevents; the promise of a reconcile stays, but as
a statement that the wait is open ended and that agents do not need respawning, rather than as the
only thing said. A denied join now names the delivery daemon as a possible cause alongside
credentials, instead of sending an operator holding valid credentials after the wrong hypothesis.

`cotal doctor auth` no longer reports a healthy fleet as broken. When a daemon re-mints an agent's
credential, the previous incarnation's file stays on disk, expired, and every one of those was
reported as `EXPIRED - the broker denies this credential` with the remedy `respawn the agent`.
Following that remedy destroys live sessions to repair nothing, because the running agent is already
using its successor. Superseded incarnations are now recognised from the credential family that
names them, reported as leftover files with a cleanup that is explicitly not a respawn, and excluded
from the verdict, while a credential that genuinely has no successor is still a problem. The remedy
for a recoverable credential now says that a running manager re-mints it and that the agent adopts
the new file without being restarted; `respawn` is reserved for material no renewal pass can rescue.
The doctor also names an unbound delivery responder when the recorded renewal pass hit one, so the
surface an operator reaches for when credentials look wrong can say that credentials are not the
fault.
