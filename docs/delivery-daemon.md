# The delivery daemon (Plane-3)

> **Concept** (informative) · **For:** operators and implementers · **Normative:** [SPEC §4](../SPEC.md#4-delivery-modes), [§7](../SPEC.md#7-channels), [§8](../SPEC.md#8-nats--jetstream-binding)

Live channel delivery is **at-most-once**: a message reaches only the peers subscribed at the
moment it is published ([SPEC §4](../SPEC.md#4-delivery-modes)). Agents are busy, mid-turn, or
offline, so a channel marked **`durable`** needs a per-member backstop that holds each post until
that member has actually seen it. The delivery daemon is the server-side component that provides
it. In the reference implementation this backstop is nicknamed **Plane-3** (the durable plane,
alongside the live subject fabric and the presence/registry state).

The backstop defines a **delivery contract** while leaving the storage layout open: [SPEC §8](../SPEC.md#8-nats--jetstream-binding)
makes the daemon's store, writer, reader, and registry reference-implementation detail. What is
normative is the [§4](../SPEC.md#4-delivery-modes) guarantee it upholds (`durable` is
at-least-once for current members within retention) and the [§9](../SPEC.md#9-nats--jetstream-security-and-authorization)
read checks it must apply. A conformant deployment may realize the backstop differently.

## The three pieces

- **Fan-out writer.** On each post to a `durable` channel it copies the message into every
  eligible member's private durable store. For an `@mention` on a *`live`* channel it also writes
  a copy for each mentioned peer authorized to read that channel, which is how a mention reaches
  an authorized peer who isn't currently joined ([SPEC §4](../SPEC.md#4-delivery-modes)). Fan-out
  handles routing; authorization remains with the broker policy. A post with an empty id is copied
  without a duplicate-suppression key, so two distinct id-less posts are both delivered and a
  redelivery of one may surface twice.
- **Trusted reader.** It pulls each pending entry, re-checks that the member is still allowed to
  read it, and hands the authorized copy to the member over an at-least-once channel (its inbox),
  keeping the entry pending until the member confirms it was surfaced. A crash between handing off
  and surfacing does not lose the message; the entry redelivers ([SPEC §8](../SPEC.md#8-nats--jetstream-binding)).
  An entry addressed to a retired lifecycle is dropped and removed from the store the first time
  the reader meets it. Retirement leaves a tombstone on that lifecycle's read-ACL row, and a retired
  lifecycle never comes back, so a later reader with a fresh cursor does not pay for it again. The
  reader acks such an entry only after the delete succeeds. A failed delete leaves the entry pending,
  so it is retried and given up after ten redeliveries, and an entry the stream no longer holds counts
  as removed. A daemon that stops serving while the delete is in flight neither acks nor gives up the
  entry, so the daemon that serves next retries it. An entry whose owner has no ACL row at all is
  retried, then given up after ten redeliveries, and kept, because a missing row does not prove the
  owner is gone.
- **Membership registry.** A privileged-written record of who is a durable member of each
  channel, carrying per-member join and leave cursors so a post concurrent with a join or leave
  orders deterministically ([SPEC §7](../SPEC.md#7-channels)). It is broker-known truth, not
  self-reported: an agent cannot assert its own membership.

## Why a *trusted* reader

The per-member store is **mixed**: it holds copies for whatever channels a member was in when
each post landed. An agent can leave a channel or lose a grant afterward, so "this inbox belongs
to agent A" is not authorization to hand A everything in it. Agents therefore hold **no
content-bearing read** on the store; the daemon reads it on their behalf and re-authorizes every
`(instance, channel, message)` entry against the member's **current read ACL** and, for
`durable`-channel entries, its **membership interval** (the post's sequence sits between the
member's join and leave cursors) before releasing content ([SPEC §7](../SPEC.md#7-channels),
[§8](../SPEC.md#8-nats--jetstream-binding), [§9](../SPEC.md#9-nats--jetstream-security-and-authorization)).

A **leave is a hard read boundary** for the backstop: once a member leaves, its backstop no
longer surfaces that channel's content. (Leaving does not revoke the ACL; the peer can still
re-subscribe live or read ACL-bounded history within `allowSubscribe`.) See
[identity-and-auth.md](identity-and-auth.md) for how the ACLs are minted and
[presence-and-delivery.md](presence-and-delivery.md) for the delivery-class model.

## Where it runs

`cotal up` on an **authenticated** mesh starts the delivery daemon alongside the broker and the
manager, as its own long-lived infra role. It runs on a **scoped, least-privilege `delivery`
credential** co-located with the broker: never an allow-all cred, and it never holds the account
signing key. One daemon serves a space (a single-flight lease guards against a second binding the
same durables).

The manager needs this daemon while it starts. Its SecretStore challenge, its boot repair of a frozen
registration gate, and the verified eviction a restart performs all go over the daemon's
`ctl.delivery-admin` rail. A manager that starts while the daemon is still binding, or while the
daemon re-checks who owns its lease, waits up to 60 seconds for the rail to answer. Only a request
that times out or finds no responder is retried. Retries come closer together as the wait runs out,
so a daemon that binds in its last seconds is still asked. The wait ends on time even while a retry
is still connecting, and nothing is sent after it. A daemon that answers fails the start at once if
it refuses or its reply cannot be read. One that stays silent for the whole wait fails it, and the
manager log names the rail.

A restart verify-evicts every holder in the manager's credential family, and the family keeps a
ledger row for every credential an earlier incarnation was issued. The manager keeps its serve,
goal-writer and session-ledger identities across restarts, so restarts add no holders; each attach
session adds one serving holder. The manager sends those holders
as one `evictPrincipals` request per 256, and the daemon answers each request with one shared sweep
of the broker. The manager records the holders each request verified before it sends the next, so a
restart cut short by its executor window resumes after the last recorded request. A daemon that does
not serve that verb refuses it, and the restart leaves the gate frozen.

An agent binds its per-member delivery durable even when the plane reached by its connection has no
ready delivery lease, so a daemon that starts later can deliver through it. A missing or not-ready
lease emits a warning that names the durable, space, and condition. It tells the agent to reconnect
against another plane if that plane serves the space, which re-binds the durable there.

Before it constructs its endpoint or claims that lease, the daemon reads the account-scoped `$SYS`
observer from the same source it will use for scans, whether that source is the workstation store or
an injected hosted store. It refuses if the observer belongs to another account, is missing, or is
part of a present but torn observer/evictor rotation. An absent evictor keeps the documented
pre-eviction, deny-new-only posture; eviction itself remains unavailable until it is provisioned.

It inherits the mesh's transport on **every** launch, including the relaunch a bare `cotal up`
performs when the daemon is missing. A TLS-required mesh always starts it with TLS demanded, so it
refuses a plaintext listener rather than upgrading on the server's unauthenticated greeting. It
holds a standing credential and reconnects unattended, so a downgrade here would repeat with nobody
watching. See [transport.md](transport.md).

The transport-health component can use the resident endpoint's NATS connection events, with no
additional authenticated dial while it is healthy. It distinguishes broker disconnects from
authentication-expiry errors and clears the corresponding failure on a proved credential adoption.
Until this component is wired into the daemon, the current two-second authenticated broker probe
remains its active broker watch.

The daemon refuses a `reloadCreds` adoption until it has finished starting, which is after its lease
watch is bound. Its lease turns ready earlier than that, so a renewal owner can ask before start-up
is done. The refusal says the daemon has not finished starting and adopts nothing. The next renewal
pass or the daemon's own 75% re-read adopts the re-signed credentials.

`cotal up` reports the daemon **only when it is actually serving**. If a daemon it started exits
without taking the single-flight lease because another daemon holds it, or because a crashed
holder's lease has not expired yet. A lease write the credential is not allowed to make is reported
as a denial naming the refused subject and operation, never as another daemon holding the lease.
`up` says so and exits non-zero instead of printing a healthy control plane over a
daemon that is not there. The daemon writes its own reason to `.cotal/delivery.<key>.log`, the log
for the space it serves ([Config](config.md#project-files)). That path is project-local. Detached
`up` redirects the daemon's stdout and stderr onto the file, so wrapping the launcher in a
systemd unit does not put those lines in that unit's journal. A daemon stopped by SIGTERM or
SIGINT, which is what `cotal down`, a service stop and Ctrl-C send, writes `received <signal>,
exiting` to that log before it releases its lease. A SIGKILL, including one from the kernel OOM
killer, ends the daemon with no line.

A foreground `cotal up` restarts a daemon it started when that daemon dies while the broker that
`up` started is still running. It logs
`delivery daemon exited (<cause>) while nats-server is running - restarting it`, then
`delivery daemon running again` once the replacement's responder is bound. A replacement whose
responder does not bind gets the same not-bound warning as at startup instead. The daemon ends
itself when it cannot reach the broker, and a starved host can make a running broker look
unreachable. Without the restart, every retirement that needs the daemon would fail until someone
ran `cotal up` again. A failed restart is logged and retried after the 30-second lease TTL. A daemon
that exits cleanly or on SIGTERM or SIGINT stays stopped. So does one that `cotal down delivery`
stops, also when the daemon is too starved to exit on SIGTERM and `down` kills it, when it is a
replacement that is still starting, and when the stop lands between two restart attempts. Detached
`up` exits after launching and restarts nothing; a bare `cotal up` relaunches a missing daemon there.

Ctrl-C on a foreground `up`, and a broker that exits under it, stop the daemon with the same stop
`cotal down delivery` uses. It holds the reservation `down` takes, so a concurrent
`cotal down delivery` is refused while it runs. It sends SIGKILL to a daemon that has not exited 15
seconds after SIGTERM, and removes the daemon's credential only once its death is confirmed. A
record whose pid now belongs to another program is cleared without a signal. If the broker exits
while that stop is running, `up` waits for the stop to finish before it exits.

The daemon **records itself** in `.cotal/delivery.<key>.pid`, whichever way it was started, and
removes that record when it exits cleanly. The launcher is not the only route to a running daemon: a
container entrypoint, a systemd unit, or `cotal deliver --space <space>` typed by hand all reach one
too, and a record written only by the launcher goes stale the moment any of those restarts it. Typed
by hand on the workstation, the daemon dials the broker recorded for the space in the mesh registry
(a mismatching `--server` is refused before any dial); with no record for the space it uses the
local mesh default, and a daemon with an injected store never consults the registry at all. The
write happens once the daemon holds the single-flight lease, because that is the point at which it is
the space's daemon: one that loses the lease refuses to bind and exits, and must not overwrite the
live holder's record on its way out.

The daemon serves one workspace root, chosen at start: the one `cotal deliver --root <dir>` names,
or the nearest `.cotal/` above its working directory. A workstation daemon with neither refuses at
start and names the directory it searched from, before it reads a credential or dials a broker,
because a directory nobody set up holds none of its credentials. A daemon with an injected store
takes its credentials from that store and needs no `.cotal/`.

Readers verify the record before believing it. A recorded pid is trusted only when the process behind
it is alive **and** its command line names a delivery daemon, so a record that outlived its process
and had its number reused is reported as stale rather than as a healthy daemon. `cotal down` never
signals such a process. Where a command line cannot be read, the record is trusted as before: the
check only ever downgrades on proof.

The daemon also hosts the space's **checkpoint timer writer** ([SPEC §13.9](../SPEC.md#139-authority-boundary)):
the standing pump that turns workflow `.schedule` requests into armed broker schedules, on its own
connection under the same delivery credential. Without a running writer no workflow pause on the
space ever expires. The writer restarts itself with backoff and logs while it is down; a fault
there never takes delivery down.

**Open dev mode has no delivery daemon.** Open mode is deliberately **live-only**: there is no
trusted reader, so there is no durable backstop. Run an auth mesh if you need durable channels.

## Without it

The self-serve **live** path never depends on the daemon: join is a broker-enforced subscribe
under `sub.allow`, so a `durable` channel still delivers live with no daemon present ([SPEC §7](../SPEC.md#7-channels)).
Only the durable backstop and its membership writes need the privileged host. If a peer joins a
`durable` channel while the backstop can't be established, it is **joined live with the durable
backstop unestablished**: the live subscription is active, and the shortfall is surfaced as an
exceptional delivery state, never reported as `joined durable` and never silently dropped ([SPEC §7](../SPEC.md#7-channels)).
