# What the private build closes, and what it does not

> ## ⚠ A SIXTH LIMIT WAS MEASURED AFTER THIS LIST WAS WRITTEN — AND HAS SINCE BEEN CLOSED
>
> **CLOSED 2026-08-15T08:36Z by MX16** (`runs/2026-08-15T0835Z-mx16-window.txt`). The mutation now
> goes to a COPY of src and a per-process resolver hook redirects every importer, so the frozen
> tree is **never written** (proven by an unchanged mtime, not by a diff) and the subject resolves
> to the private build (proven by class identity, not by a printed line).
>
> **Limit #2 below is closed by the same change**: "mutate a private COPY of the source" was
> recorded there as the route that would close it, and that is what was built.
>
> **What was true until then:** `--private-build` could not grade `packages/core` through
> `connection-control.smoke.ts`. The
> mutant lands in the private build; the cells drive a `MeshAgent`, whose `@cotal-ai/core` import
> resolves to the shared `dist`, so the graded run executes unmutated core. **Any core mutation run
> that way SURVIVES regardless of cell quality.** MX14, `FINDING-mx14-survived-vacuously.md`,
> commit `5231e102`.
>
> **This is not one of the five below and it is not a variant of them.** They are limits on what the
> remedy *covers*; this is a limit on what the remedy can *grade at all*. **Do not read the table
> below as exhaustive.**
>
> **The section header "What it DOES close" is the one to read sceptically:** it closes the blast
> radius, and it closed the reach along with it — mutations reached the connector *because* they
> were written to the shared build.
>
> **A qualification, not a revision.** The rest is unedited pending the resolver-hook decision
> (register item 9).

**Stamped `2026-08-15T06:4xZ` (`date -u` at writing), lane tip `a7743ea6`.**

Written because **a remedy whose limits are unstated gets cited later as though it had none.** The
private build (`packages/core/smoke/_core-entry.ts`, `mutation-proof --private-build`, verified by
`meshctl-m12-seam-control.mts`) closes one specific hole. It is narrower than its name suggests.

## Read this table first: the five limits are NOT the same kind of thing

**Three of these will never be closed and two are open work.** They read at the same weight in the
sections below, and they should not — one is a proof, one is a deliberate design boundary, one
belongs to a different owner, and only two are a backlog.

| # | limit | kind | who closes it |
| --- | --- | --- | --- |
| 1 | does not stop an ordinary build | **PERMANENT BY DESIGN** — closing it would destroy the distinction the whole rule rests on (different vs. deliberately wrong). **The freeze covers this, and the two are disjoint, not redundant.** | nobody; it is correct as it stands |
| 4 | detects nothing, and nothing can | **PERMANENT — PROVEN IMPOSSIBLE**, three ways. Not a backlog item and not worth another attempt. | nobody; the impossibility is the finding |
| 5 | symlinks unchanged; the fleet still runs an unmerged core | **NOT THIS CHANGE'S TO CLOSE** — a different decision with an irreversible edge | the human ruling on the links |
| 2 | `connection-lifecycle` uncovered | **OPEN, deliberately deferred.** Closable. Named rather than fixed on instruction, to keep this change scoped. | this lane, when unblocked |
| 3 | no other lane, package or harness covered | **OPEN, scope decision.** Closable by wiring more packages or making the flag the default. | whoever owns those harnesses |

**If you are inheriting this branch: #2 and #3 are the only entries that are work.** Treating #1 or
#4 as a to-do will waste your time, and treating #5 as this lane's to-do will have you making a
decision that is not yours.

---

## What it DOES close

**A mutation proof driven through `mutation-proof --private-build packages/core`, against a suite
that carries the seam, cannot compile a mutant into `packages/core/dist`.** The mutant goes to a
scratch directory created by that run; the suite is pointed at it by `COTAL_CORE_ENTRY`; the harness
refuses to grade at all if the suite does not report having loaded a private build.

That is the exact act that put a knowingly defective core under every Claude and OpenCode seat on
this box for about two and a half minutes (`FINDING-mutation-on-shared-dist.md`).

**Two suites carry the seam:** `connection-control.smoke.ts` and `meshctl-m11-startleak.mts`.

---

## What it does NOT close

### 1. It does not stop an ORDINARY build

`pnpm build` is `pnpm -r build`, and `./node_modules/.bin/tsc -p packages/core` is in this repo's
own error messages as the remedy for a stale dist. **Either writes `packages/core/dist` — the
fleet-linked artifact — and neither goes anywhere near the seam.** The seam governs mutation proofs;
it does not govern building.

**This is not a gap to be fixed by widening the seam.** An ordinary build makes the shared artifact
*different*, which the workspace expects and which is a normal thing to do in a worktree. A mutation
makes it *deliberately wrong*. The rule turns on that distinction, and a remedy that also blocked
ordinary builds would be wrong.

**But it means the freeze currently in force is doing work the seam cannot do.** They are not
redundant, and lifting the freeze on the strength of the seam would be a mistake.

**And "an ordinary build" is a wider category than it sounds.** At this tip, **fifteen scripts in
this `package.json` invoke a build through the dependency-inclusive `...` filter, and twelve of them
are named `smoke:*`** — see register item 10. **So this limit is not a corner case reachable only by
someone typing `pnpm build`; it is reachable by running a smoke.** Every citation of dist stability
on this branch carries that scope, and the MX16 record now states it where the result is written.

### 2. It does not cover `connection-lifecycle.smoke.ts`

That suite imports core as `../src/index.js` — **direct source, compiled in-memory by `tsx`.** It
never needed a build, which is why it does not have the seam and why widening it was explicitly not
done.

**The residual is real and stays named: a mutation in `packages/core/src` is a shared-tree mutation
the moment ANYONE runs `tsc`.** The mutant source sits in the tree for the length of the proof; any
concurrent build in this worktree — another lane's, a tool's, a habit — compiles it into the
fleet-linked dist. The proof itself never builds, so nothing in the proof is watching for that.

#### What would move #2 from OPEN to CLOSED — recorded, NOT built

**Mutate a private COPY of the source, never the shared source.** The harness would copy
`packages/core/src` into the run's own scratch, apply the `--find`/`--replace` there, compile that
copy, and point the suite at it through the existing `COTAL_CORE_ENTRY` seam. **The shared
`packages/core/src` is then never written at all** — so there is no window in which a concurrent
`tsc` can compile a mutant, and `tsx`-direct suites like `connection-lifecycle.smoke.ts` become
coverable by the same mechanism instead of being the exception.

It also collapses the signal residual below: with no shared-tree write there is nothing for a
`SIGKILL` to strand (`SIGNAL-SAFETY-mutation-proof.md`). Restore stops being a recovery obligation
and becomes a `rm -rf` of a directory nobody else resolves.

**Two things it does not close**, so it is not a silver bullet: a suite that imports the shared
source by a relative path must still be re-pointed (the seam already does this, but every such
suite has to carry it), and the copy's own `node_modules` resolution has to work — the reason the
current scratch lives *inside* the package rather than in `/tmp`.

**Recorded on instruction and deliberately not built tonight.** Building it now would be a second
untested mechanism inside the same window the first one is about to be proven in.

### 3. It does not cover any other lane, package, or harness

Only this lane's two suites carry the seam, and only `packages/core` has been wired. **Any mutation
proof anywhere in this repo that targets a built package, without `--private-build`, has exactly the
original hazard.** The flag is opt-in and nothing requires it.

### 4. It does not detect outside resolvers, and nothing can

This is the load-bearing limit. **You cannot enumerate who resolves a shared path**, proven three
ways in `DESIGN-mutation-private-build.md` §2: `st_nlink` on the artifact is `1` (the filesystem
keeps no reverse index of symlinks, controlled with a planted hard link that reads `2`); `lsof` is
empty (Node closes the descriptor after import); a directed scan can prove presence and never
absence.

**So the seam is not "safe because we checked who reads it".** It is safe because it writes a path
that did not exist until the run created it. **Exclusivity by construction, and construction is the
only kind available.**

### 5. It does not change the symlinks, and the fleet is still on an unmerged branch

Measured now, and this is the whole current exposure, not a sample:

```
~/.config/cotal/extensions/node_modules/@cotal-ai/connector-claude-code/node_modules/@cotal-ai/core
~/.config/cotal/extensions/node_modules/@cotal-ai/connector-opencode/node_modules/@cotal-ai/core
        both -> <this worktree>/packages/core
```

**Exactly two links, both to `packages/core`.** That is a fact about the current link layout, **not
a property this change established** — it is why `packages/core` was the right package to wire, and
it will stop being true the moment anything installs or repoints. `connector-codex` and
`connector-hermes` resolve to the principal checkout instead.

> ### 🔴 FALSE, MEASURED 2026-08-15T09:1xZ. THE WORD "INSTEAD" IS THE ERROR — ANNOTATED, NOT REVISED
>
> **The principal checkout is not the other arm. At first-party package level it is an alias for
> this worktree.** Its package-level `node_modules` entries are RELATIVE links that climb out of the
> principal and back in here:
>
> ```
> /home/david/Cotal/bin/node_modules/@cotal-ai/core
>         -> ../../../../Cotal-wt-fm-meshctl/packages/core
> ```
>
> **Census of the principal, raw link text, negative control returning 0 on a marker that must not
> match:** **61 symlinks climb into this worktree**; **21 are first-party `@cotal-ai/*`**; **13 of
> those are in `bin/node_modules/` — the published binary's composition root** (`core`, `cli`,
> `manager`, `delivery`, `web`, `auth`, `workspace`, `connector-core`, the four connectors, `pi`).
> `implementations/{cli,manager,delivery}` and `packages/workspace` each resolve `@cotal-ai/core`
> here as well. The principal's ROOT link is correct (`../../packages/core`) — **but package-level
> resolution wins**, because Node walks up from the importing file and meets the package-level entry
> first.
>
> **So `connector-codex` and `connector-hermes` do not resolve elsewhere. They reach this branch in
> two hops.** And `mc-cleanup` reaches it in three: satellite → here → principal → back here.
>
> **CONSEQUENCE FOR THE INCIDENT THIS FILE EXISTS TO BOUND: the MX14 blast radius is understated
> above.** For the ~2.5 minutes a mutant sat in `packages/core/dist` it was reachable not only by
> two installed connectors but by every first-party entry point resolving through the principal's
> `bin`, `cli`, `manager` and `delivery`. **The number two was right about the installed-extension
> layer and wrong about the exposure.**
>
> **And the dependency runs both ways.** Both stores hold 419 `.pnpm` entries and **40 of the 61
> climbing links reach into THIS worktree's store** — so anything that repopulated it would break
> the live checkout's resolution at 61 points. **That direction was never guarded.**
>
> **How the original claim was reached, because the method is the lesson:** one `readlink`, not
> followed one hop further. **A resolved path was recorded as an endpoint.** The measurement above
> resolves the full chain and states its control.
>
> **Nothing has been repointed, removed or tidied**, here or in the installed-extension layer.
> Recorded, not fixed — the links are load-bearing for whatever installed them.

**Every Claude and OpenCode seat on this box still loads core from this lane's unmerged branch.**
The seam stops a *mutant* reaching them. It does nothing about the nine unmerged connection-control
commits they are already executing, which is a separate open question for whoever rules on the
links.

---

## The one-line version

**The private build closes this lane's mutation proofs' blast radius on `packages/core`. It does not
make the shared tree safe, does not survive an ordinary `tsc`, does not extend to other lanes or
packages, and does not detect anything.** Cite it for what it is.
