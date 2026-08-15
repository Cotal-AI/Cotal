# `lifecycleUid` nested inside `card` — the defect, and what I predict fixing it does

Found while typechecking `.lane/window-arms.mts` before the box window. The standalone `tsc` rejected
my harness at `TS2353`; the harness had copied the shape from
`implementations/delivery/smoke/delivery-health-live.smoke.ts:288`, which has carried it since
`555bcb12f` (2026-08-14, this lane's branch). **It is my lane's defect, not another lane's.**

## What is actually wrong

`lifecycleUid` is a **sibling of `card`** in `EndpointOptions` (`packages/core/src/endpoint.ts:157`).
`AgentCard` (`packages/core/src/types.ts:18-45`) has **no such property** — the one at `types.ts:76`
belongs to `Presence`, which is why so many manager smokes legitimately write
`{ card: {...}, status, lifecycleUid }`. Nested inside `card` it is an excess property, so
`opts.lifecycleUid` is `undefined` and, for an **authed** endpoint, `ownLifecycleUid` stays
`undefined` (`endpoint.ts:543-548`).

## Why it went unnoticed, which is the more general finding

**`pnpm typecheck` does not reach smoke files.** So the compiler never saw it. The defect was only
exposed because I ran `tsc` directly at a file that had copied the shape.

## Scope: ONE occurrence repo-wide, and it is mine

Instrument: `grep -rnP "card:\s*\{[^}]*lifecycleUid"` over `*.ts`/`*.mts`, excluding `node_modules`
and `dist`.

| control | result |
| --- | --- |
| loose pattern `card:.*lifecycleUid` | **24 matches** — proves the grep reaches source |
| **negative control**: tightened pattern against the known-correct sibling form at `packages/core/smoke/channels-auth.smoke.ts:95` | **NO match** — it correctly rejects the correct form |
| tightened pattern, whole repo | **1 match**: `delivery-health-live.smoke.ts:288` |

The 23 rejected lines are the positive control's other half: the shape is normally written correctly,
so a single hit is a real outlier and not a pattern that matches everything.

## What it costs — read from call sites, NOT assumed

A uid-less endpoint: `start()` **throws** if authed and consuming or presence-registering
(`endpoint.ts:894-895`); cannot durable-leave (`:3066`), consume DMs (`:3206`), read chat history
(`:3515`), or list durable memberships (`:3119`).

**It does NOT block `plane3Channels`.** `durableJoinChannel` (`:3055-3056`) sends no uid — the daemon
derives identity from the requester's cred. I record this because my first draft of the harness
comment claimed the nesting would have falsified Arm A's `hasDurableMembership`, **and that was
wrong**. Arm A's prediction is unaffected.

The observer escaped every one of those consequences because it sets `consume:false,
registerPresence:false, channels:[]`. **That is why 20/0 was green and the green is not in doubt.**

## The comment at `:278-279` is FALSE, and its own green run refutes it

It claims *"the cred and the endpoint card must carry the SAME uid or the broker denies the very reads
this observer exists to make."* The card carried no uid at all (the compiler says so) and the broker
denied nothing. **The broker checks the CRED's grants** — `mintCreds(..., { lifecycleUid })` at `:281`
is the half that mattered, and it was always correct.

## The one real behavioural change, and the PREDICTION

With the uid at the top level, `requestDeliveryHealthProbe` sends `lifecycleUid: OBSERVER_UID`
instead of the literal placeholder `"health-probe"` (`endpoint.ts:1433`, the `??` fallback).

**PREDICTED: 20/20 green, ZERO cells change verdict.** Named, because a count is not a prediction:

| cell | predicted | why |
| --- | --- | --- |
| `control: with the daemon live, health is SERVING (this validates the probe itself)` | **unchanged PASS** | the probe's contract is *any reply counts, including an error reply*; a real uid changes WHICH reply, not WHETHER one comes |
| `daemon-gone: the affirmative surface REFUSES` / `…as no-responder specifically` | **unchanged PASS** | no daemon ⇒ no reply, whatever the arg |
| `WEDGED: yet the affirmative surface REFUSES` / `…as no-responder specifically` | **unchanged PASS** | a wedged daemon answers nothing, whatever the arg |
| `WEDGED inverse control: SIGCONT restores SERVING` | **unchanged PASS** | same round-trip, real uid |
| the 15 lease / pid / marker / group-absence cells | **unchanged PASS** | never touch the endpoint's uid |

**FALSIFIER, registered now:** if `control: … health is SERVING` or `WEDGED inverse control: SIGCONT
restores SERVING` reddens, then the reply depended on the placeholder uid — which would mean the
probe does **not** behave as its own doc comment at `endpoint.ts:1417-1424` claims, and that is a
finding about the probe worth more than this fix. I will report it as loudly as a defect.

## Status of the green while this is uncommitted-and-unrun

The 20/0 at `555bcb12f`..`48d34228` **stands as measured** and is re-derivable at those hashes. After
this fix it must be **re-derived**, and it is queued as **arm zero** of the box window — cheap, and
it is the control every other arm leans on. **Until that re-run, no green is claimed for the fixed
file.** The box is not mine until `GATE_EXIT`.
