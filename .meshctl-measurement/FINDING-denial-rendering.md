# Finding: the repo has four purpose-built ways to name a permission denial, and the verb every seat uses has none of them

Recorded `Fri Aug 14 10:06:55 PM UTC 2026` (`date -u`, read at the moment of writing) at tip
`5156e248`. Filed as its own record, on fm-orchestrator's suggestion, because it was found inside a
mutation round and would be lost there. **It is a property of the shipped surface, not of a test.**

## What was measured

`E13` in `extensions/connector-core/smoke/connection-control.smoke.ts`, driven
`Fri Aug 14 09:44:58 PM UTC 2026` against an ephemeral loopback broker. A seat with
`allowPublish: ["general"]` posts to `#secret`. **Recorded, not asserted** — neither outcome was
established beforehand.

**Two renderings of that single denial exist at the same instant.**

What the **endpoint error channel** gets (`packages/core/src/endpoint.ts:4514`, reaching the log via
`extensions/connector-core/src/agent.ts:225`):

    NATS permission denied: cannot publish "…secret" - check this endpoint's ACLs
      (a denied peer looks "absent" rather than blocked)

What the **tool caller** gets (`extensions/connector-core/src/tool-specs.ts:348`):

    isError=true
    Couldn't send: Permissions Violation for Publish to
      "cotal.meshctl-authed.chat.local.<lifecycle-uid>.secret"

**The good one names the condition and even warns about the precise confusion this lane spent the
night chasing. The caller never sees it.** The caller's version quotes an internal wire subject
carrying the endpoint's lifecycle UID, and never says `#secret`, never says "publish ACL", and
cannot be branched on.

**The measurement is trustworthy because it is not a lone print:** the same run's `E12` asserts the
message was *not* witnessed at the broker and `E11` asserts the subject's in-ACL post over the
*same* witness list *was*. `E13` is the caller's-eye view of an event two assertions already pinned
from outside.

## ⚠️ The real finding: this is not a missing mechanism. It is four existing ones, unrouted.

Following the good message back, the repo turns out to contain — **already written, already
reviewed, already documented** — everything the fix needs:

| Mechanism | Where | Status |
| --- | --- | --- |
| `describeStatusError` — turns a raw status error into one that says *why* | `packages/core/src/endpoint.ts:4510` | **not exported; exactly one call site**, `:2524` |
| `isPermissionDenied` — denial vs. service-down | `endpoint.ts:4527`, **exported** | imported by `tool-specs.ts:16` |
| `isPublishPermissionDenied` — denial **on a publish**, i.e. provably not stored | `endpoint.ts:4552`, **exported** | used at `agent.ts:959` |
| `controlFailure` — renders a denial with the grant to add | `tool-specs.ts:40` | used by spawn `:612`, despawn `:701`, persona `:764` |

**Three of those four live in files `cotal_send` already imports. `tool-specs.ts` imports
`isPermissionDenied` on line 16 and defines `controlFailure` on line 40 — and `cotal_send`'s catch
on line 348 is `err(\`Couldn't send: ${(e as Error).message}\`)`.**

`controlFailure`'s own doc comment states the principle the send path violates:

> *"A permission denial … is a different failure with a different fix than an absent/unreachable
> manager. Report them apart instead of always blaming the manager (which sent the operator chasing
> a non-existent 'manager down')."*

`isPublishPermissionDenied`'s comment goes further, and is explicitly about a caller in
`cotal_send`'s position — *"the operation matters enormously to a caller that reports delivery"* —
noting that a caller must fail toward *"I could not confirm"* rather than *"it did not happen."*
**`cotal_send` reports delivery to an agent and consults neither predicate.**

> ⚠️ **The privileged control verbs — spawn, despawn, define-persona — all got the careful
> treatment. The everyday verb that every seat uses, on every task, did not.**

*The remedy for the class exists and is unreachable from where it is needed.* That is the third
instance tonight of the same shape, and fm-orchestrator's generalisation of it is the right one:
**this codebase's problem is more often delivery than diagnosis.**

## Why it survived

Measured on my own account, `Fri Aug 14 09:37:39 PM UTC 2026` (`cotal_orientation`): a
feature-manager holds `post: #>` — the full-subtree publish grant.

> **I cannot reach this defect from my own account no matter what I am asked to deliver, because
> every destination is inside my grant. The population at risk is exactly the least-privileged
> seats, and every account that would naturally investigate is too privileged to reach it.**

Recorded in full at `.meshctl-measurement/DESIGN-route-refusal.md` §0b. It generalises past this
bug: **any defect whose precondition is a NARROW grant is invisible to everyone empowered to
investigate it.**

## What this record does and does not argue for

**It argues for routing, not for new diagnosis.** The fix is to render the denial the caller
receives with the machinery that already exists — naming the channel and the ACL, not the wire
subject — and it does not require inventing a mechanism, a new error class, or a client-side ACL
gate.

**It does NOT argue for a client-side publish gate.** That case is made and declined at
`.meshctl-measurement/FINDING-publish-gate-asymmetry.md`: a gate would be a second place for the ACL
to be wrong, and would still not detect the case that matters (a *wrongly permitted* publish has no
rejection to carry any signal).

**It does not propose a code change on its own authority.** `cotal_send` is adjacent to the
`capabilities` gate this lane owns, but this is a defect record; the change belongs to whoever holds
that surface.

## What is NOT established

- **Measured for `cotal_send` on a chat channel only.** The DM and anycast paths are not driven.
- **`describeStatusError` was read, not driven.** That it has one call site is a grep result; that
  the send path *cannot* reach it is inference from the call graph, not a measurement.
- **The "indistinguishable from a broker outage" claim is REASONING, not measurement.** I have the
  denial string and I do **not** have the outage string, so I have never compared them. Settling it
  needs a publish against a broker taken down mid-run.
- **The leaked lifecycle UID is reported as an information-exposure smell, not as a vulnerability.**
  What an attacker could do with a seat's lifecycle UID is not measured here.
