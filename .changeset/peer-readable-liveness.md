---
"@cotal-ai/core": minor
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/delivery": patch
---

Let a credentialed peer ask which plane is broken, instead of guessing at its own credentials

The subjects that answer "is the manager alive" are owner-only, so a peer holding perfectly valid
credentials could not ask. When its join or its send failed, that peer could not tell a credential
problem from a dead manager, an unbound delivery daemon, or a broker that was entirely healthy, so
every failure presented as a credential failure, because that was the only hypothesis it was able to
form. A reporter running a 30-agent deployment for a week recorded six independent surfaces that each
reported success over a failure, including a `pgrep` that matched its own command line and therefore
failed in both directions. In every case diagnosis cost hours rather than minutes, and in every case
the missing piece was the same: nothing could be asked whether it was alive by anyone who did not own
it.

A read-only liveness surface now answers that question. A peer sends a presence probe on
`live.<plane>.<owner>.<actor>` and learns whether the manager and the delivery daemon have bound
responders for the space. It is shaped like the Synadia micro protocol's `$SRV.INFO`, a well-known,
read-only, presence-only request/reply probe, but it rides a Cotal subject inside the space rather
than the literal `$SRV` tree, which sits outside per-space account isolation and outside every grant
builder and subject audit the system already enforces.

Presence is the whole answer. The reply carries exactly the plane and one responder verdict: no
holder, no pid, no workspace root, no instance id, no runtime, no roster. That is why the probe is a
request rather than a lease read: the manager's lease row carries the operator's filesystem path and
a process id, so the responder reduces it to a single enum and the row never crosses the wire. A peer
gains no read of either lease bucket, cannot probe under another principal's identity, and cannot
subscribe the responder's serve filter to answer for a plane it does not own.

Unknown stays first class, reusing the classifier `cotal status` already grades by. Only the broker's
own no-responders answer becomes "unbound"; a timeout, a permission refusal or an unreadable reply
all become "unknown", because each is a failure to find out, and reporting a failure to find out as
health is the defect this surface exists to remove. A responder that cannot determine its own state
says so rather than guessing, and a reply is never counted as health merely for having arrived.

The reply also names which responder answered it, as an opaque per-bind token and not an identity.
Manager instances coexist per instance id, each responder answers only about itself, and the queue
group hands one probe to one arbitrary member, so two instances holding opposite verdicts made
identical probes alternate with nothing in the answer to say a second instance existed. With the
token a caller that probes more than once can tell two responders apart from one responder that
changed state. One probe still samples one responder and cannot report a split by itself.

A remote manager can now answer the probe it already binds. It runs the same start path as a local
supervisor, so it binds the manager plane's responder, and its credential carried neither the serve
subscription nor the bounded reply row. The subscription was denied and a peer asking about the
manager plane received the broker's own no-responders answer, which grades "unbound": a definite
verdict about a plane that was in fact bound, produced by a gap in a credential. Both rows are now
on that profile, pinned to the supervisor actor that does the serving.

The responder's rejection notice for a reply target outside the sender's own subtree now travels on
the endpoint's non-fatal warning channel. It was emitted on the `error` channel, and Node's
`EventEmitter` rethrows an `error` emitted with no listener attached, so an embedder that had not
attached one ended its process when a peer sent a probe naming such a target. The plane was then
genuinely unbound and the next probe reported it as such, so the notice manufactured the state it
described. The guard's behaviour is unchanged: the frame is dropped and the responder keeps serving.
