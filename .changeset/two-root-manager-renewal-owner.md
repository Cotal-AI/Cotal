---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

Let a space carry a manager on more than one workspace root

A manager whose workspace root was not the delivery daemon's threw at start on any auth-mode space,
naming both roots. A participant machine could not run a manager for a space it had joined, and a
second manager on the same machine from a different checkout could not start either, so an auth
space was capped at one manager. The per-instance manager liveness lease was demoted from a
per-space singleton precisely so a second manager in a second workspace root would coexist, and
this refusal put that cap back for every space with auth.

The refusal exists for a real defect. The manager re-signs the standing daemon credentials through
its own `SecretStore` and then asks the daemon to adopt them by fingerprint, with no credential
bytes and no shared-store coordinate on the wire. A manager that remints into a store the daemon
never reads has every adoption refused for as long as the daemon's 24 hour window lasts, and the
challenge on the daemon's `reloadStoreIdentity` is what proves that composition is not being built.

That proof is kept, and it is now applied to the process it is about. The store identity selects
which manager owns the daemon's credential renewal rather than deciding whether a manager may run.
The daemon names one store, so at most one manager can match it, and only that manager remints.
A manager on any other root starts, serves its own agents, renews its own supervisor, goal-writer,
session-ledger and managed-agent credentials, and remints no daemon credential. It reports both
stores on every renewal pass and says that it wrote nothing, so an operator whose space has no
manager on the daemon's own root is told repeatedly rather than once at a start that no longer
fails. Refusing that start renewed nothing in the first place: the daemon's root is just as
unrenewed with the second manager dead as with it running.

Failing closed is unchanged everywhere it was load bearing. A delivery-admin rail that hangs, a
daemon that will not name its store, and an unparseable identity still end the start. A daemon
that is not bound yet is still not a named store, so remint proceeds into this manager's store and
a daemon that binds later on a foreign store stops the remint from the next pass.

Carrying the re-signed credential bytes to a daemon on another host, and a negotiated renewal lease
for the several managers that would then be able to renew, are not part of this change.
