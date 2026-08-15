# EVIDENCE PACKAGE — `cotal_channels` reports a durable backstop as active when the delivery daemon does not exist

*Self-contained on purpose: everything needed to reproduce and judge this is below, with no reference
to anything outside the repository. Hand this to an issue filer as-is.*

---

## Summary

The `cotal_channels` MCP tool reports **`· durable backstop active`** for a channel whose server-side
delivery daemon has been killed and whose process group is confirmed absent. Every agent on the mesh
reads this surface. It is not an operator-only view.

The three inputs the "active" verdict is derived from are all satisfied by a dead daemon.

## Impact

An agent asking "is my durable backstop working" is told yes while the daemon that provides it does
not exist. This is the same failure mode as the incident the delivery-health work came from —
messages accepted, senders told they were sent, nothing reporting a problem — except surfaced to
every agent rather than to nobody.

The third state is worse than a bare unknown: when health cannot be established the expression yields
`undefined`, which `tool-specs.ts:422` renders as the **empty string**. The channel line is then
indistinguishable from one where delivery health never applied. There is no "cannot establish"
rendering at all.

## Where it is

`extensions/connector-core/src/agent.ts:1006-1022`. Verified present at `origin/main` by reading the
blob directly (`git show <main>:extensions/connector-core/src/agent.ts`), not the working tree.

```js
let leaseLive = false;
let daemonKnown = false;
try {
  leaseLive = (await this.ep.readDeliveryLease(0))?.ready === true;   // :1010
  daemonKnown = true;                                                 // :1011
} catch { /* open dev mode or no delivery plane here */ }

const health = (channel, joined) =>                                   // :1019
  daemonKnown && joined && this.ep.channelDeliveryClass(channel) === "durable"
    ? (leaseLive && this.ep.hasDurableMembership(channel) ? "active" : "degraded")
    : undefined;
```

Rendered to the agent at `extensions/connector-core/src/tool-specs.ts:418-422`:
`"active"` → `· durable backstop active`; `undefined` → `""`.

## Why every conjunct is satisfied by a corpse

**`leaseLive`** — the daemon's lease is a KV record. A `SIGKILL` runs no graceful release, so the
record survives with `ready: true` and a heartbeat well inside its TTL. Measured: heartbeat **311ms
old** at the moment the surface was read, with the daemon's process group confirmed absent.

**`hasDurableMembership(channel)`** — `packages/core/src/endpoint.ts:3168-3169` is
`return this.plane3Channels.has(channel)`, an **in-memory Map on the agent's own session**, not a
broker read. Its three `.set` sites (`:1577`, `:3125`, `:3152`) are all membership-established paths;
its two `.delete` sites are `:1614` (an explicit durable leave) and `:3065` (refused-subscription
cleanup); there is no `.clear()`. **Neither delete is driven by daemon liveness.** A session that
established membership while the daemon was alive keeps it after the daemon dies.

**`daemonKnown`** — this is the sharpest part. It is set to `true` at `:1011` **because the lease read
at `:1010` did not throw**. It is therefore a signal that *the reader had permission*, not that *a
daemon exists*. A denied reader and a dead daemon are not distinguished by it in any way. The flag is
named for daemon knowledge and carries grant information.

**`channelDeliveryClass(channel) === "durable"`** — a registry property of the channel, unaffected by
daemon state.

## The code already knew about this class of bug

The comment at `agent.ts:1015-1018` states that the membership conjunct exists so a channel renders
*"degraded, never a false 'active' off the lease alone (ux honesty blocker)"*.

So one false-active path was identified and deliberately closed. The path where **the lease itself is
a dead daemon's residue** was not. Guarding the instance you thought of is not the same as guarding
the class.

## Measured evidence, with both bounds

Driven through the real `MeshAgent.listChannels()` — the method behind the `cotal_channels` tool —
against a real delivery daemon on an ephemeral loopback broker. Not a re-implementation of the
expression; the actual code path an agent uses.

| # | condition | result |
| --- | --- | --- |
| A1 | **control**: live daemon, durable membership established | `deliveryHealth === "active"` |
| A5 | **inverse control**: channel with no durable membership | **not** `"active"` |
| — | daemon `SIGKILL`ed; exit observed, whole process **group** confirmed absent | — |
| A3 | the lease after the kill | still `ready: true`, heartbeat inside TTL |
| A2 | `hasDurableMembership` after the kill | still `true` |
| **A4** | **the shipped surface after the kill** | **`"active"`** |

**A1 and A5 are why A4 counts.** A1 establishes the field *can* be `"active"`; A5 establishes it *can*
be something else. Without both, an `"active"` reading over a corpse could be a constant rather than a
verdict. Final run: 16 cells, 0 failures, exit code 0 read from an EXIT-trap artifact.

## Measured residue window: 30.07 seconds

The 311ms reading above is ~1% into the lease TTL, so on its own it could be dismissed as a guard
given no chance to fire rather than one that failed. Sampling the whole window settles it. The lease
TTL is `LEASE_TTL_MS = 30_000` (`packages/core/src/streams.ts:83`), the bucket-level `max_age` on the
delivery lease bucket.

Elapsed measured from a clock read at the kill, never counted in loop iterations:

    t+    11ms  deliveryHealth=active     lease=ready=true
    t+ 10029ms  deliveryHealth=active     lease=ready=true
    t+ 20051ms  deliveryHealth=active     lease=ready=true
    t+ 28067ms  deliveryHealth=active     lease=ready=true
    t+ 30072ms  deliveryHealth=degraded   lease=no-record

**The false `active` is available for essentially the entire 30-second window, not just as a race at
the moment of the kill.** The window is BOUNDED — this is not an indefinite lie, and the report
should not be read as claiming one.

Two further facts from the same run:

- **What clears it is the lease TTL expiring, and nothing else.** At the transition the lease read
  returns no record at all.
- **The membership conjunct never cleared.** `hasDurableMembership` was still `true` at the end of
  the run, after the surface had already moved to `degraded`. Only the lease expiry moved it, which
  is what the absent `.clear()` predicts.

So the surface self-corrects after ~30s, and it self-corrects to `degraded` — not to any named
refusal, and not to the empty state. For a surface an agent consults before relying on a backstop,
30 seconds of confident wrong answer is long relative to the requests it is about to make.

## Provenance — which artifact was measured

Presence on `main` was established by reading the BLOB at origin/main
(`git show <main>:extensions/connector-core/src/agent.ts`), NOT a working tree, because the measuring
tree carried unrelated in-progress work. The expression is at line 1020 of that blob.

NEGATIVE CONTROL for that read: `requestDeliveryHealthProbe` — a symbol that exists only in the
in-progress work — occurs ZERO times in the blob. That establishes both that the read was of shipped
code without local additions, and that the search discriminates rather than matching everything.

**A CORRECTION IS RECORDED HERE RATHER THAN SWALLOWED.** An earlier draft carried `endpoint.ts` line
numbers uniformly **+19** off the shipped positions — `:3187-3188`, `:1596`/`:3144`/`:3171`,
`:1633`/`:3084`. Those came from the working tree, not the blob. The numbers in this report are the
shipped ones, verified site by site. **The substance was unchanged by the correction** — three sets,
two deletes, no `.clear()`, neither delete driven by daemon liveness — and it was independently
re-derived by a second party before filing.

The negative control above could not have caught this, and it is worth naming why: it tested whether
local additions were PRESENT in the text being read, not whether the line numbers came from the same
artifact as the quoted code. A control answers the question it was built for and no other.

## Reproduction

1. Start a `nats-server` on loopback with an ephemeral store dir, and provision a space
   (`setupSpaceStreams` with a `provisioner` cred). **Assert the broker URL is loopback before
   anything connects.**
2. Start the delivery daemon against that space with a `delivery` cred, detached in its own process
   group; record its pid at creation.
3. Register a channel in the channel registry with `deliveryClass: "durable"`. *(Required:
   `listChannels()` reads the registry, so an unregistered channel yields no row at all and no health
   field — an easy way to mistake "no row" for "no defect".)*
4. Provision an agent as a manager would — `provisionAgent(provisioner, auth, identity, { subscribe,
   allowSubscribe, lifecycleUid, role })`. **`role` is required**, or the role's task queue is never
   created and the connector never reaches a durable join.
5. Start a `MeshAgent` on those creds. Its read set field is named `subscribe` (not `channels`).
   **Poll `hasDurableMembership(channel)` until true** rather than sleeping a fixed interval.
6. Confirm `listChannels()` reports `deliveryHealth: "active"` — **this control must pass before the
   kill, or the rest proves nothing.**
7. `SIGKILL` the daemon's whole process **group**. Wait for the observed exit, then poll until
   `process.kill(-pid, 0)` throws.
8. Read `listChannels()` again → **`deliveryHealth` is still `"active"`.** Read the lease → still
   `ready: true`.

## Suggested direction (not a fix; the owning lane should decide)

1. **`"active"` should require an affirmative round-trip to the daemon's responder**, not a lease
   read. A bounded request that the daemon must answer is the smallest signal that cannot be
   satisfied by residue. Timeout and no-responder are refusals, not passes.
2. **`daemonKnown` should not be consumed as liveness.** If the code needs "is the reader permitted",
   read and name that separately; a denial and an absence are different facts and are separable at
   the broker.
3. **The `undefined` state needs a rendering.** Silently omitting the health clause makes "cannot
   establish" look identical to "not applicable".

## Not claimed

- This does not establish how long a real agent holds a stale membership in production — only that
  nothing in the mechanism clears it when the daemon dies.
- The measurement was taken on an ephemeral loopback broker with one daemon and one shard.
- No fix, patch, or pull request accompanies this package.
