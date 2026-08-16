---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

Say what a refused publish, a goal deadline, and a class-queue split actually proved.

A refused publish now reports itself. `nc.publish` is fire-and-forget: a caller whose credential
does not authorize the subject gets an asynchronous answer on the *connection*, so the publish
returns normally and the only observable is that no reply arrives. That is indistinguishable from
an absent responder, though the two need opposite responses — mint the grant, or go find the
responder. An instance-addressed describe made with a class-rail credential is exactly that case,
and it read as an unresponsive manager: measured live, `ps --on <instance>` returned `no describe
reply from manager within 10000ms` against a 115ms RTT while an untargeted describe answered from
either instance in well under a second. The describe now watches its connection for a permission
violation on its own subject and raises `permission-denied` naming that subject, the instance rail,
and the fact that the responder may be perfectly healthy. The watch closes its status iterator on
every exit, so it does not leave a listener parked on the connection per resolve.

A goal that produced no terminal in time no longer implies the goal failed. It was accepted; only
its terminal did not arrive within the wait. Observed live: seats that reported this had already
come up and were messaging peers, and retrying submitted a second goal that duplicated the effect.
The message now says the deadline is on the wait rather than the work, and says not to retry on it
alone.

An unpinned class-queue split no longer implies the effect did not land. Describe and invoke are
separate trips through the same anycast queue, so in a multi-instance space the instance that won
the queue received the request and may have executed it — possibly after the error was raised. The
message now says so, points at `ps`/`inspect`/roster before any retry, and names `--on` as the way
to avoid the split.

And a split is no longer silently retried into a duplicate effect. The client recovered from
`failed-precondition` by dropping its cached resolve and invoking again, which is a repair when the
bound incarnation is gone but a second attempt when the error came from a different live instance
answering the class queue: request received and answered (executed or refused; the reply does not
say which), error raised afterwards. Re-invoking there re-issued the command automatically, while
the error text told the operator not to retry; it is the mechanism behind one spawn producing
several seats. The retry now happens only for commands
whose second execution is observably indistinguishable from one — the reads and `describe`. Every
other command surfaces the split to its caller, carrying a marker that says a responder did answer
the request, so the caller can check before deciding. Surfacing also drops the stale bind: the
cached resolve named an incarnation a different live instance has just answered for, and keeping it
would send every later deliberate call on that endpoint into the same refusal, so the caller could
verify and still never reach the live instance. Dropping it re-issues nothing; the next call is the
caller's own.

The same rule now covers the adjacent case, a manager restarted in the same workspace root. That
restart keeps the logical instance id and advances its epoch, so a client that resolved before it
gets its next answer from the same id at a later epoch: `expired`, raised after the attributed reply
just like the split. It used to be rethrown untouched with the bind kept, so a long-lived client
(a connector's mesh agent, the console) reached the successor on every later call, may have applied
the effect each time, and never recovered. The stale-epoch refusal now carries the same
responder-answered marker, the guard keys on the marker rather than the error code, and its message
says which side is stale: a responder ahead of what the caller holds is a successor (re-resolve to
adopt it), one behind is a superseded incarnation still answering. The old text called the caller's
own bound epoch the responder's "current" epoch, which named the wrong side.

That classification is an allowlist and fails closed at both levels. It is keyed by endpoint, not by
bare command name, because the client is endpoint-agnostic and a flat list would lend the manager's
judgement to any endpoint that happened to reuse a name — an endpoint nobody has classified has no
repeat-safe commands, and an unlisted command is surfaced rather than repeated. `describe` is the one
exception, and structurally so: it is served by the machinery on every endpoint and can never be
redefined into something that mutates.

`models` is deliberately not on that list even though it is a read command. With `{refresh: true}` it
reaches the connector's model listing and, for OpenCode, re-fetches provider catalogs and rewrites a
cache — the same name, in the same grant class, answering differently because of an argument the
classification cannot see. A plain `cotal models` therefore surfaces a split rather than absorbing it
in a multi-instance space; encoding per-command argument rules here would reintroduce exactly the
fail-open shape this replaced. That is the clearest statement of what the list is: a client-side
stand-in for something the wire does not yet carry — a safety annotation on the command contract and
an effect outcome in the reply — which remains open.

`ps` prints the full instance id in its multi-manager view. That view appears only where the split
makes `--on <instance>` the one way to address a manager, and `--on` accepts nothing but the whole
26-32 character lifecycle token — so an abbreviated header named the remedy and withheld the value
it needed, and `--on <prefix>` was refused as a malformed token. The `stop`/`attach` seat-lookup
miss, which lists the instances that did not answer for the same purpose, prints them whole too and
says the id must be passed as printed.
