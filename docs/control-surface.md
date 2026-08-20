# The control surface

> **Concept** (informative) · **For:** operators and client authors who want to know how the manager and other daemons are driven · **Normative:** [SPEC §13](../SPEC.md#13-endpoint-control-surface-v04)

Cotal once had a privileged control rail: a fixed set of named service tiers
(`self` / `manager` / `admin` / `delivery`) on their own `ctl.*` subjects, with the manager
as a special case the broker recognised by name. That rail is gone. Everything that serves
structured commands now, the manager, the delivery daemon, a wrapped MCP server, a
third-party service, is an ordinary **endpoint**: a daemon that registers a service
identity, publishes its contracts, and answers `describe`. `manager` is an endpoint name
like any other; no subject, envelope, or grant in this surface knows it specially. The
manager is a service on the mesh, not an authority over it: it holds only the capability
rows its callers grant it, and serves over a scoped credential.

## The `ep` rails

One kind, `ep`, carries every request under a mode token that says where the request
routes, never which verb it is (the verb rides the envelope): `one` (queue-group anycast,
exactly one class member), `all` (scatter, every instance), and `inst` (one instance by its
stable address). Replies come back on a `reply` rail keyed to the serving instance and its
epoch. Around these sit the sibling planes the composites use: per-goal events, timers,
sessions, and the journal that holds durable facts. Every request carries the caller as
three forge-locked tokens, `owner`, `actor`, and lifecycle `uid`, plus an unguessable
nonce, so the broker polices who is calling in the subject grammar itself. See
[SPEC §13.2](../SPEC.md#132-grammar) for the grammar and [§13.5](../SPEC.md#135-verbs) for
the verbs (`call`, `cast`, `watch`, `claim`, `scatter`).

## Lifecycle identity

A principal `owner.actor` is a reusable routing alias: a despawn frees the actor name and a
later spawn may legitimately reuse it, so the alias alone is never authority. Two further
coordinates make an identity durable: a **lifecycle uid**, an unguessable, never-reused id
for one managed lifecycle under a principal, and a **process epoch**, the fenced ownership
epoch of the process currently animating it, advanced on every restart or takeover. At most
one live epoch owns an identity, and a superseded epoch must stop serving. Durables and
credentials key on the lifecycle uid, not the reusable name, which is what lets a
supervised restart recover the same lifecycle instead of minting a new one. See
[SPEC §13.1](../SPEC.md#131-lifecycle-identity) and [identity & auth](identity-and-auth.md).

## Discovery: describe and invoke

No client has compile-time knowledge of any endpoint's commands. `cotal describe
<endpoint>` resolves a registered endpoint's command set off the wire: the reserved
`describe` command answers the registered contract digests, the schemas are fetched from the
space's content-addressed contract store, recompiled, and verified against those digests.
Each command prints with its capability class and targeting shape. `cotal invoke <endpoint>
<command> --args '<json>'` then calls one command by name, validating the arguments against
the fetched input schema before publish. Every built-in manager command uses this same
trust chain, so there is nothing the built-ins can reach that a described contract cannot.
See [SPEC §13.7](../SPEC.md#137-contracts-and-discovery) and [cli.md](cli.md).

## Spawn is a goal

Long-running commands are **actions** ([SPEC §13.6](../SPEC.md#136-composites)): the caller
submits with a client-generated `goalId` and a request fingerprint, the endpoint records a
durable accept or reject decision, progress rides per-goal events, and the work ends in one
terminal outcome (`succeeded`, `failed`, `cancelled`, `expired`, or `uncertain`). Spawn is
the reference case. Rather than block the caller for up to 30 seconds while an agent comes
up, the manager accepts the goal and returns the allocated identity at once:

```json
{
  "name": "reviewer-2",
  "owner": "u_...", "actor": "reviewer", "uid": "...",
  "goalId": "...", "fingerprint": "...",
  "executor": { "lifecycleUid": "...", "epoch": 3 }
}
```

The name is the one actually allocated: a persona-derived collision is auto-numbered
(`reviewer`, then `reviewer-2`), while a hard-pinned `--name` that collides with a live
agent is refused at accept, before anything is minted. The triple plus `goalId` let the
caller follow progress (connector handoff, process launched, presence join) and reconcile
later against the exact instance that accepted. Presence within the 30-second readiness
window settles the goal `succeeded`; an early process exit is `failed`; the window passing
with neither is `uncertain`, a bounded, durable outcome that a later `ps` or status read
settles against the live roster. `uncertain` is a real terminal outcome, not an absence and
not a silent hang. It carries the diagnosis of whoever owned the deadline: for a launch that
names the agent and says to inspect it rather than re-issue, since re-issuing after a launch
that in fact succeeded mints a duplicate. A committer that supplies no diagnosis falls back to
"the success signal did not arrive within the readiness deadline". The agent's own eventual
state is then observable on its presence record.

## Instance addressing and scatter

A space can run more than one manager. Each manager persists a stable logical instance id
across restarts and advances its process epoch when it comes back, so callers address a
specific manager without caring which process currently serves it. An untargeted spawn
rides class anycast (any manager may accept, and the acceptance records which one did);
`cotal spawn <persona> --detach --on <instance>` pins one instance by its exact id (a
foreground spawn has no manager to pin and refuses the flag). There are no ordinal
aliases and no short forms: wherever a display names an instance you can address, it prints
the whole id, because `--on` takes nothing else.

The resolve and the invoke are separate trips through the same anycast queue, so in a
multi-manager space an unpinned call can land on an instance the caller did not resolve. Every
call carries the incarnation it resolved against, and a manager that is not that incarnation
**refuses before running the command** — so the failure an operator sees says the command did
not run, and re-issuing it cannot duplicate the effect. That is the difference that matters for
a mutation: the older behaviour detected the mismatch on the reply, after the manager had
already acted, and could only tell you to go and check. `--on` still matters for reaching a
specific manager (`ps`, `stop`, `attach`, `spawn --detach`), but it is no longer what stands
between a split and a duplicated spawn. Against a manager older than this fence the refusal is
still after the fact, and its message says so. The re-issue is automatic only when the refusal
states `not-executed` in its `outcome` field; a refusal that omits the field, or states
`unknown`, is surfaced to the caller instead of repaired, because neither proves the command did
not run. `ps` and
`status` become a **scatter** across every registered instance: the caller freezes the
expected set from the service registry, invokes each under a shared deadline, and merges the
results with per-instance attribution. A non-answering instance is labelled as registered
with no answer within the deadline, never silently omitted. See [SPEC §13.5](../SPEC.md#135-verbs) (scatter) and [cli.md](cli.md).

The expected set comes from the **registry**, which records registration rather than liveness.
An instance that crashes never deregisters, so it stays in the set and the gather has nothing
left to wait for but an answer that cannot come. It pays the whole deadline, on every scatter,
indefinitely. A scatter can therefore be given a per-instance liveness probe: when the broker
itself reports that an instance holds no subscription on its own instance rail, the gather stops
waiting for it. Only that affirmative report counts. A lapsed presence entry, a probe that timed
out, and a probe that failed are all *absence of evidence*, and treating any of them as death
would turn a slow correct answer into a fast wrong one, so they leave the full deadline standing.
Nothing about the outcome changes either way: an instance that did not answer is still
unreachable, still surfaced, and the scatter is still not complete.

The probe is supplied by the **caller**, not invented by the scatter. Asking about an instance is
a publish on that instance's rail, and a credential that holds no row for it is refused by the
broker asynchronously, while the publish itself returns normally. A refused probe is therefore
silent, and silence is exactly what a live but slow instance looks like. Only the layer that
minted the credential knows which ids it may ask about, so that layer asks about those and no
others, and prints any refusal the broker raises anyway rather than letting it expire into a
timeout. `cotal ps` freezes the class on its first connection, re-mints an instrument pinned to
exactly the frozen ids, and scatters on a second.

This does not help against an instance that is **connected but not answering**. A hung manager
holds its subscriptions, so it is indistinguishable from a slow one, and it still costs the full
deadline. That is the correct result, not a gap in the probe.

### Deregistration

A probe makes a dead registration cheap to skip; it does not remove it. Removal is the
registration's own exit, and there are exactly two routes to it, both explicit
([SPEC §13.5](../SPEC.md#135-verbs): a deleted `svc` spec *is* the deregistration).

A manager that stops cleanly deletes its own two records keys as part of stopping, so an instance
that was shut down leaves no row behind. This is a **graceful stop** only. A manager that loses
its lease tears down fail-closed and deliberately does not deregister: it is not the authority on
its own record at that point, and the incarnation that took the lease from it is.

For the instance that cannot cooperate, an operator names it:
`cotal deregister-instance --instance <id>` ([cli.md](cli.md#deregister-instance)). It removes the
record only on the same evidence `cotal ps` acts on: the broker reporting nothing subscribed on
that instance's own rail. It refuses if the instance answers a describe, refuses if the probe could
not run at all, and refuses if the instance is merely quiet, because a hung process still holds its
subscriptions and is therefore not affirmed gone. Nothing sweeps the registry on an age threshold
or on silence.
An instance that is deregistered while it is merely wedged re-registers over the tombstone on its
next start, which is what makes the operator's decision a recoverable one.

## Attach sessions

`cotal attach` no longer returns a `ws://127.0.0.1` URL. It creates a one-use, holder-bound
session offer: the manager mints a token bound to the caller, the target lifecycle, its own
instance id and epoch, and an expiry, and replies with a session id and expiry only, no URL
and no secret in the reply. The CLI redeems the offer over the mesh (a second redeem is
refused), and terminal bytes then stream on core-NATS session subjects scoped to the two
parties. Backpressure is a bounded in-flight window with an explicit drop notice, never
silent loss; a late attach still repaints the full screen from a replayed terminal
snapshot. Close, expiry, target despawn, and a manager restart are distinct, surfaced end
states: a restarted manager's successor refuses the old epoch's sessions and the client
shows "manager restarted; re-attach".

## Seat input

`attach` is a stream, so it is the wrong shape for a program that wants to send one line: it
holds a session open and expects a terminal at the caller's end. The `input` command is the
other half. One authorized call writes text into a running seat's terminal as if it had been
typed there, and answers with the seat and the number of bytes delivered.

It exists for **harness commands**. A line beginning with `/` (`/compact`, `/clear`, `/model`)
is neither chat nor an event: the agent's own harness handles it, and the keyboard is the only
way in. An external control surface that can already read a seat's turns and talk to it still
cannot drive it without this.

The op is targeted, rides the `manager.lifecycle` capability, and declares authz modes `owner`
and `any`, the row shape `attach` and `despawn` already carry, checked by the same authorization.
Enter is appended unless the caller suppresses it, and nothing is echoed back, since the resulting
turns already have somewhere to go.

**Who may call it is narrower than either of those**, and the reasoning is worth stating because
the natural assumption is wrong. `despawn` and `attach` are granted to anything holding `spawn`;
`input` is granted only to operator credentials. The tempting argument for treating them alike is
that an attach session's `write` already reaches the same terminal, so `input` adds nothing. It
does not reach it: an attach yields a signed session offer, and redeeming one needs a per-session
credential minted from the space signing seed, which no agent holds. So `input` would be new
authority, and the own-owner rule that bounds `despawn` covers every seat under an owner rather
than only the ones a caller launched. Killing a peer is denial; typing into a peer is control of
it. The write therefore sits with the credential that is already the administrative authority for
the domain.

Only a runtime that owns the child's input stream can serve it. The `pty` runtime does; the
external terminal runtimes attach to a process they do not own, and there the command refuses
and names the runtime rather than dropping the keystroke. A seat that is not running refuses for
its own reason, and the two are distinguishable, so a caller can tell "this will never work"
from "not right now". See [cli.md](cli.md#input).

## Grants

There is no broad control credential. A caller holds one capability row per command it is
allowed to send, and minting maps each named capability to exactly the request subjects it
needs, nothing wider. The manager serves over a scoped serve credential that can answer and
reply but cannot, for instance, write another endpoint's records or forge a goal terminal;
the goal-fact writer and the session writer are separate, narrowly scoped credentials the
broker fences by subject. Authorization is checked at the serving boundary, and for actions
it linearises at acceptance: a spawn refused there mints no reservation and leaves no
process. See [SPEC §13.9](../SPEC.md#139-authority-boundary) and
[identity & auth](identity-and-auth.md).

## See also

- [Architecture](architecture.md), where the manager and the wire fit in the whole system.
- [CLI](cli.md), for `describe`, `invoke`, `spawn`, `ps`, `status`, `attach`, and `input`.
- [SPEC §13](../SPEC.md#13-endpoint-control-surface-v04), the normative contract.
