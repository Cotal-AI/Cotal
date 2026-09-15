---
"@cotal-ai/core": minor
"@cotal-ai/cli": patch
---

Let a credentialed peer ask which plane is broken, instead of guessing at its own credentials

The subjects that answer "is the manager alive" are owner-only, so a peer holding perfectly valid
credentials could not ask. When its join or its send failed, that peer could not tell a credential
problem from a dead manager, an unbound delivery daemon, or a broker that was entirely healthy — so
every failure presented as a credential failure, because that was the only hypothesis it was able to
form. A reporter running a 30-agent deployment for a week recorded six independent surfaces that each
reported success over a failure, including a `pgrep` that matched its own command line and therefore
failed in both directions. In every case diagnosis cost hours rather than minutes, and in every case
the missing piece was the same: nothing could be asked whether it was alive by anyone who did not own
it.

A read-only liveness surface now answers that question. A peer sends a presence probe on
`live.<plane>.<owner>.<actor>` and learns whether the manager and the delivery daemon have bound
responders for the space. It is shaped like the Synadia micro protocol's `$SRV.INFO` — a well-known,
read-only, presence-only request/reply probe — but it rides a Cotal subject inside the space rather
than the literal `$SRV` tree, which sits outside per-space account isolation and outside every grant
builder and subject audit the system already enforces.

Presence is the whole answer. The reply carries exactly the plane and one responder verdict: no
holder, no pid, no workspace root, no instance id, no runtime, no roster. That is why the probe is a
request rather than a lease read — the manager's lease row carries the operator's filesystem path and
a process id, so the responder reduces it to a single enum and the row never crosses the wire. A peer
gains no read of either lease bucket, cannot probe under another principal's identity, and cannot
subscribe the responder's serve filter to answer for a plane it does not own.

Unknown stays first class, reusing the classifier `cotal status` already grades by. Only the broker's
own no-responders answer becomes "unbound"; a timeout, a permission refusal or an unreadable reply
all become "unknown", because each is a failure to find out, and reporting a failure to find out as
health is the defect this surface exists to remove. A responder that cannot determine its own state
says so rather than guessing, and a reply is never counted as health merely for having arrived.
