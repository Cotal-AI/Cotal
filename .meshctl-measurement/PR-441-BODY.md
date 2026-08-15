# DRAFT PR BODY for #441 — staged, NOT posted

**Why this file exists:** the force-push to `feat/agent-connection-control` is blocked by a
permission denial in this lane's session and has been taken to the human. This body is drafted now
so that clearing the verb is **one action, not a conversation**. Numbers below are measured at
`a9cf56f0`; re-derive them if the branch moves before it lands.

**Do not post the section above this line.** Everything below the rule is the body.

---

## Scope

Agent-driven mesh connection control: an agent granted `capabilities: [connection]` can take itself
off the mesh and bring itself back, through two new tools — with the fences that bound what a
self-directed connect can reach, and the probes that drive those fences against a real broker.

**Read the diff in two halves — they are very unequal, and the split is the first thing to know:**

| half | files | lines | what it is |
| --- | --- | --- | --- |
| **product** | **13** | **+2,310 / −35** | the feature, its suites, its docs, the changeset |
| `.meshctl-measurement/` | 48 | +8,916 | this lane's **working records** — measurements, predictions, panel verdicts, run logs |

**79% of this PR by line count is a notebook, not a product change.** It is called out here rather
than left to be discovered at review, because AGENTS.md puts working build-plans and research in
`.internal/` and keeps `docs/` protocol-only — so **whether that directory should merge at all is a
real question, and it is the merger's to answer, not the author's.** The material is already public
on this branch, so nothing is protected by staying quiet about it. The product half stands on its
own if the directory is dropped.

The product half:

```
packages/core/src/endpoint.ts                                  scripts/generate-tool-docs.mjs
packages/core/smoke/connection-lifecycle.smoke.ts              extensions/connector-core/src/agent.ts
packages/core/smoke/request-strand.smoke.ts                    extensions/connector-core/src/config.ts
extensions/connector-core/smoke/connection-control.smoke.ts    extensions/connector-core/src/tool-specs.ts
docs/agent-files.md  docs/manifest.md  docs/mcp-tools.md       .../src/docs-bundle.generated.ts
.changeset/quiet-moons-attend.md
```

## The authority question, and its answer

A self-connect is an authority surface before it is a convenience surface: an agent that can attach
itself to a mesh is an agent choosing what it can see and who can reach it. **The design constraint
was that a self-connect must carry nothing the agent did not already hold**, and the shape that
delivers it is that `cotal_connect` **takes no target**. It returns to the mesh the session was
launched against, with the credential source it was launched with. It can therefore ask for no scope
the operator did not grant, and reach no mesh the agent was not already on.

**That is enforced at the broker, not decided by the client**, and the suite proves it that way:

- **E18 — the fence.** The same credential re-pointed at another space is refused **by the broker's
  permissions**, naming the foreign subject.
- **E17 — its inverse control.** The same credential, through the same constructor, *does* reach its
  own space — so E18 is a bounded credential rather than a broken probe.
- **E8 / E10 / E12.** After a self-reconnect the credential comes back **no wider than it left** — on
  reads, on subtree shape, and on publish — each paired with a live control arm (E9, E10-univ, E11)
  so the silences are denials and not dead probes.

Credential renewal no longer outlives a deliberate disconnect, and a stale credential is re-read on
the way back, so **access revoked while the agent was away returns as a refusal rather than as a key
that still works.**

## Refusals are named, and a refusal is hard to mistake for success

Outcomes are a **discriminated union, not a boolean**, so "treat a refusal as success" is awkward to
write rather than the default. Each failure mode names the condition that failed —
`transition-unconfirmed`, `teardown-failed`, `bind-failed`, `in-flight-request`,
`credential-source-unavailable` — and the suite asserts **that** refusal rather than *a* refusal
(`[not-connected]`, `[already-connected]`, and the recovery path refusing to reverse a deliberate
departure while naming the verb that does). The loose form survived a mutation; the strict form is
what shipped.

## What a supervisor sees

`cotal_disconnect` **announces the departure first, confirms it at the broker, and only then tears
down.** If the announcement cannot be confirmed it refuses and stays connected. **An agent that goes
dark on request is therefore distinguishable from one that crashed** — asserted at the broker via an
independent observer, in open mode *and* under real auth, each with a control arm establishing the
observer could see the subject at all beforehand.

**Stated limit:** the cause string is *display only*. An observer can read it; it does not let an
observer distinguish a genuine departure from a stale heartbeat. Recorded in the design note rather
than implied away.

## Three lifecycle defects, found by driving the verbs and fixed with them

- A connect that failed **after** the broker accepted the transport left that authenticated
  connection **open and unsupervised** while telling the caller it was refused.
- A failed teardown reported that it had retracted the departure announcement when it had already
  dropped the handle needed to send one — so peers went on seeing a still-connected agent as gone.
- Credential renewal kept dialling from an endpoint that was deliberately off.

Also on the request/reply path: `stop()` settled in-flight requests but left admission open, so a
request issued during a stop was accepted and never settled. Admission now closes at the sweep, and
the refusal says the request was **never published** — safe to retry, unlike a stranded one whose
outcome is unknown.

And two false claims are removed from the tool surface: `cotal_leave` claimed a guard against
leaving your only channel that does not exist, and the connection verbs were hidden from ungranted
static-credential sessions but not from ungranted user-mode ones.

## Verification, and what it does NOT cover

Driven through the **real tool entry points**, not internal helpers, against ephemeral loopback
brokers that refuse the live host in code rather than by runbook.

- `connection-control`: **45 passed / 0 failed / 0 VOID**, including the authed arm.
- `connection-lifecycle`: **48 / 0**. `request-strand` and the start-leak probe driven and green.
- **Mutation-proofed with named predicted cells**, with the mutant shown non-equivalent at the
  broker — not merely reddening a cell.
- Reviewed by a **five-seat panel** in independent worktrees; verdicts are in
  `.meshctl-measurement/verdicts/` verbatim, including the ones that blocked. The final re-anchored
  verdict is CLEAR.

**Named gaps — listed so their absence cannot be read as coverage:**

1. **The live E2E half is BLOCKED, not skipped.** A user team from outside the build passed the docs
   half (and found a real defect while doing it: `docs/manifest.md` gave an exhaustive-looking
   capability list that omitted `connection`). The live half cannot run because **the installed
   build predates the feature** — `grep -c cotal_disconnect` over the shipped
   `@cotal-ai/connector-core@0.17.0` `dist/tool-specs.js` is `0`. A seat can hold
   `COTAL_CAPABILITIES=connection` and the card will advertise it while the running build has no way
   to honour it. That is a **version-skew hazard**, not a defect in this change. The four unrun live
   checks are named in `.meshctl-measurement/FINDING-e2e-blocked-by-skew.md`.
2. **The most recent suite re-drive did not capture an observed exit code**, and its log is
   tail-only. Both faults are recorded in the run file itself rather than left to be assumed away.

## Not ready to merge on my say-so

This branch was **force-pushed over a rewritten history**; the pre-rewrite tip is preserved as
`pre-forcepush-441`. The rewrite substituted no content — the old remote tip and its corresponding
local commit carried an **identical tree**, with an empty `git diff` between them.

Needs a normal human review before landing, and the `.meshctl-measurement/` question above answered
as part of it.
