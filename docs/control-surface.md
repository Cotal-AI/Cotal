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
not a silent hang: it says "the success signal did not arrive within the readiness
deadline", and the agent's own eventual state is then observable on its presence record.

## Instance addressing and scatter

A space can run more than one manager. Each manager persists a stable logical instance id
across restarts and advances its process epoch when it comes back, so callers address a
specific manager without caring which process currently serves it. An untargeted spawn
rides class anycast (any manager may accept, and the acceptance records which one did);
`cotal spawn --on <instance>` pins one instance by its exact id. There are no ordinal
aliases and no short forms: wherever a display names an instance you can address, it prints
the whole id, because `--on` takes nothing else. Pinning is not only a preference: the
resolve and the invoke are separate trips through the same anycast queue, so in a
multi-manager space an unpinned call can be received and answered by one instance while
the caller is told it did not bind, and `--on` is the way to avoid that split. `ps` and
`status` become a **scatter** across every registered instance: the caller freezes the
expected set from the service registry, invokes each under a shared deadline, and merges the
results with per-instance attribution. A non-answering instance is labelled unreachable,
never silently omitted. See [SPEC §13.5](../SPEC.md#135-verbs) (scatter) and [cli.md](cli.md).

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
- [CLI](cli.md), for `describe`, `invoke`, `spawn`, `ps`, `status`, and `attach`.
- [SPEC §13](../SPEC.md#13-endpoint-control-surface-v04), the normative contract.
