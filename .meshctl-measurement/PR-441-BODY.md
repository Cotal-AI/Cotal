# DRAFT PR BODY for #441 — staged, NOT posted

**Why this file exists:** the force-push to `feat/agent-connection-control` is blocked by a
permission denial in this lane's session and has been taken to the human. This body is drafted now
so that clearing the verb is **one action, not a conversation**. Numbers below are measured at
`f0ec7e0b`, against base **`7cc74f50`** = `git merge-base <origin/main> HEAD`; re-derive them if the
branch moves before it lands.

**Get the base right or every number below is wrong.** Derived against a stale *local* `main` this
diff appears to carry eight other lanes' changesets and a repo-wide version bump — an alarming and
entirely false reading, caused by the local ref being behind. `git ls-remote origin refs/heads/main`
read **`a4aabbe4`** at `2026-08-15T07:2xZ`, which already contains that release. **Note that this
lane's standing orders name `1aab1389` as `origin/main`; the remote has moved since. Reported, not
acted on — fetching and rebasing are not this lane's to do.**

**Do not post the section above this line.** Everything below the rule is the body.

---

## Scope

Agent-driven mesh connection control: an agent granted `capabilities: [connection]` can take itself
off the mesh and bring itself back, through two new tools — with the fences that bound what a
self-directed connect can reach, and the probes that drive those fences against a real broker.

**Read the diff in two halves — they are very unequal, and the split is the first thing to know:**

| half | files | lines | what it is |
| --- | --- | --- | --- |
| **product** | **17** | **+2,488 / −40** | the feature, its suites, its docs, the harness, the changeset |
| `.meshctl-measurement/` | 58 | +10,198 | this lane's **working records** — measurements, predictions, panel verdicts, run logs |

**80% of this PR by line count is a notebook, not a product change.** It is called out here rather
than left to be discovered at review, because AGENTS.md puts working build-plans and research in
`.internal/` and keeps `docs/` protocol-only — so **whether that directory should merge at all is a
real question, and it is the merger's to answer, not the author's.** The material is already public
on this branch, so nothing is protected by staying quiet about it. The product half stands on its
own if the directory is dropped.

The product half:

```
packages/core/src/endpoint.ts                                  extensions/connector-core/src/agent.ts
packages/core/smoke/connection-lifecycle.smoke.ts              extensions/connector-core/src/config.ts
packages/core/smoke/request-strand.smoke.ts                    extensions/connector-core/src/tool-specs.ts
packages/core/smoke/_core-entry.ts                             .../src/docs-bundle.generated.ts
extensions/connector-core/smoke/connection-control.smoke.ts    scripts/generate-tool-docs.mjs
docs/agent-files.md  docs/manifest.md  docs/mcp-tools.md       scripts/mutation-proof.mjs
package.json  .gitignore  .changeset/quiet-moons-attend.md
```

`scripts/mutation-proof.mjs`, `packages/core/smoke/_core-entry.ts` and the two `.gitignore` /
`package.json` lines are **test-infrastructure, not feature code** — the private-build seam and the
suites' names. They are in the product half because they ship; they are described under
*Verification* below.

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

Credential renewal no longer outlives a deliberate disconnect, and a stale cached credential is
re-read on the way back.

**Do not read that as a revocation guarantee — it is not one, and the docs say so.** What was
measured is narrower: a disconnect/connect pair re-presented the **cached** credential without
fetching a new one. **Whether a credential revoked while the agent was away is caught on return is
not measured**, because settling it needs a live broker and a real revocation. It is registered as
an open question against the E2E stage, and both doc pages tell the reader to assume it is *not*
re-checked until someone measures it.

**The distinction is the point:** "connect asks for nothing new" is a **bound** on what was
observed, not a **guarantee** about what cannot happen. The bound is what this change claims.

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

**Which build these results describe — stated, because on a developer box it is not the obvious
one.** Every result below is the subject of **this branch's build**, not of any installed release.
The suites import the connector from `../src/*.js` in the worktree, and the bare `@cotal-ai/core`
specifier resolves through a workspace symlink to `packages/core/dist/index.js` in the worktree —
verified with `import.meta.resolve`, not assumed — behind a guard that refuses to run at all if that
`dist` is older than any core source file. **So these numbers say how the merged code behaves, and
say nothing about how any currently-installed runtime behaves.** The two are genuinely different on
this host today, and **in two different ways at two different versions**:

| artifact | version | serves | `cotal_disconnect` / `cotal_connect` |
| --- | --- | --- | --- |
| `cotal` on `PATH` (`~/.local/share/cotal`) | 0.17.0 | anything shelled out to the CLI | 0 / 0 |
| `…/connector-claude-code/dist/mcp.cjs` | **0.16.0** | **the `cotal_*` MCP tools an agent actually calls** | 0 / 0 |

**0.16.0 is the one that matters for this change**, because connection control is reached through MCP
tools rather than through the CLI. A reader who takes the results above as runtime claims would be
reading them about code that does not serve calls here. (Not everything on this box is stale — the
supervisor runs from the checkout — so this is a **per-call-path** statement, not a blanket one.)

- `connection-control`: **45 passed / 0 failed / 0 VOID**, including the authed arm.
- `connection-lifecycle`: **48 / 0**. `request-strand` and the start-leak probe driven and green.
- **Mutation-proofed with named predicted cells**, with the mutant shown non-equivalent at the
  broker — not merely reddening a cell. **Read the mechanism with that claim, because it changed
  underneath it:** those proofs were obtained the *pre-seam* way, by compiling the mutant into the
  shared `packages/core/dist` — which is precisely why they reached the connector, and precisely why
  they had a blast radius. **The harness as it ships here cannot reproduce them through this suite**:
  `--private-build` puts the mutant somewhere only the suite's own imports resolve, while the cells
  drive a `MeshAgent` whose `@cotal-ai/core` resolves to the shared build, so a core mutation run
  that way survives regardless of cell quality. Measured, with the survival diagnosed rather than
  interpreted: `.meshctl-measurement/FINDING-mx14-survived-vacuously.md`.
  **The evidence above stands and the mechanism that produced it is gone.** Safety and reach were
  the same property; containing the blast radius removed the reach with it. Restoring the reach
  safely is an open decision (register item 9), not a claim made here.
- **Both suites now have names** (`smoke:connection-control`, `smoke:connection-lifecycle`). They
  had none: 45 cells and a lifecycle suite reachable from no `package.json` script, runnable only by
  someone who remembered a path. Deliberately **not** added to the `check` chain — naming a suite is
  an author's call; changing what the aggregate gate runs is not, and it is flagged for the merger.
- **The mutation harness no longer writes the shared build.** A proof of this lane's own compiled a
  deliberately broken `@cotal-ai/core` into `packages/core/dist`, which two installed connectors
  symlink — so every agent session on that host executed a knowingly defective core for the length
  of the run. `--private-build` now compiles the mutant into a scratch directory and points the
  suite at it through a `COTAL_CORE_ENTRY` seam; the harness refuses to grade unless the suite
  confirms it loaded the private build. Filed against this lane in
  `.meshctl-measurement/FINDING-mutation-on-shared-dist.md`, with its limits stated separately so
  the remedy is not cited as broader than it is.
- **The harness survives an interrupt.** It had no signal handlers, so a plain Ctrl-C left the
  mutated source in the working tree. Registering listeners fixes it — and the mechanism is not the
  obvious one: the handler body never runs, because `spawnSync` blocks the event loop for the whole
  window. What protects the tree is that registering a listener replaces the signal's default
  disposition. That is recorded next to the listener, because the body looks dead and is not.
  `SIGKILL` remains uncatchable; recovery is `git checkout --`, which is why the harness refuses a
  dirty tree.
- Reviewed by a **five-seat panel** in independent worktrees; verdicts are in
  `.meshctl-measurement/verdicts/` verbatim, including the ones that blocked. The final re-anchored
  verdict is CLEAR.

**Named gaps — listed so their absence cannot be read as coverage:**

1. **The live E2E half is BLOCKED, not skipped.** A user team from outside the build passed the docs
   half (and found a real defect while doing it: `docs/manifest.md` gave an exhaustive-looking
   capability list that omitted `connection`). The live half cannot run because **the build serving
   the seat's tools predates the feature**: the artifact named in the seat's own `--mcp-config` is
   `@cotal-ai/connector-claude-code@0.16.0` `dist/mcp.cjs`, built `2026-08-13 22:58Z`, and its
   `cotal_disconnect` and `cotal_connect` counts are both `0`. A seat can hold
   `COTAL_CAPABILITIES=connection` and the card will advertise it while the build serving it has no
   way to honour it. That is a **version-skew hazard**, not a defect in this change. The four unrun
   live checks are named in `.meshctl-measurement/FINDING-e2e-blocked-by-skew.md`, along with a
   correction: that finding originally cited the CLI's `connector-core@0.17.0` rather than the
   artifact that actually served the seat. Same zero, wrong subject — corrected in place.
2. **The most recent suite re-drive did not capture an observed exit code**, and its log is
   tail-only. Both faults are recorded in the run file itself rather than left to be assumed away.
3. **Revocation-on-return is UNMEASURED** — see the authority section. It needs a live broker and a
   real revocation, so it belongs to the E2E stage, and the docs already take the unsafe-until-proven
   side. This is the sharpest open question on the surface and it is stated, not buried.

**The open decisions this branch does not close** — including whether these suites join the `check`
chain, and two connector symlinks that point installed extensions at this worktree — are collected
with an owner each in `.meshctl-measurement/GATE-OPEN-DECISIONS.md`, rather than left in the
conversation that produced them.

## Not ready to merge on my say-so

This branch was **force-pushed over a rewritten history**; the pre-rewrite tip is preserved as
`pre-forcepush-441`. The rewrite substituted no content — the old remote tip and its corresponding
local commit carried an **identical tree**, with an empty `git diff` between them.

Needs a normal human review before landing, and the `.meshctl-measurement/` question above answered
as part of it.
