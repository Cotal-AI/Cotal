# A mutation proof in this worktree injected a defect into the whole fleet's core

**Stamped `2026-08-15T05:2xZ` (`date -u` at writing), lane tip `dd696c67`.**
**This is a finding against THIS LANE'S OWN METHOD, not against another lane's work.**

## What happened

`~/.config/cotal/extensions/node_modules/@cotal-ai/connector-claude-code/node_modules/@cotal-ai/core`
and the matching `connector-opencode` path are **symlinks into this worktree**:

```
connector-claude-code -> /home/david/Cotal-wt-fm-meshctl/packages/core
connector-opencode    -> /home/david/Cotal-wt-fm-meshctl/packages/core
connector-codex       -> /home/david/Cotal/packages/core        (main checkout)
connector-hermes      -> /home/david/Cotal/packages/core        (main checkout)
```

So **every Claude seat and every OpenCode seat on this box loads its `@cotal-ai/core` from this
lane's unmerged branch.** The lane did not create that link and had no way to see it.

On `2026-08-15`, a prior seat of this lane ran the start-leak mutation proof. **A mutation proof
writes `packages/core/dist` twice** — once to install the mutant, once to restore it — because the
mutant is an edit to `packages/core/src` that must be compiled to be executed.

The mutant was **`discardHalfBound` removed from `start()`**: half-bound connections are no longer
discarded on start. That is a **connection-lifecycle defect**, and it was live in the core under
every Claude and OpenCode seat on this box.

## The window, bounded by the run records' own mtimes

| time (UTC) | event | core the fleet was loading |
| --- | --- | --- |
| `03:06:29Z` | baseline `m11-startleak` record written | clean |
| *(between)* | **mutant `dist` written — no timestamp survives, the restore overwrote it** | — |
| `03:07:16Z` | MUTANT run header stamped | **DEFECTIVE** |
| `03:08:42Z` | MUTANT `m11-startleak` record written | **DEFECTIVE** |
| `03:08:53Z` | `dist` rebuilt — the **restore** | clean again |
| `03:09:42Z` | restored-run record written, proving the restore took | clean |

**Roughly two and a half minutes during which the fleet ran a knowingly defective core.** Any seat
that started, reconnected, or rebuilt a handle in that window did so against it.

**Current state is clean, verified rather than assumed:** `grep -c discardHalfBound` is **4** in both
`dist/endpoint.js` and `src/endpoint.ts`, and `git diff --exit-code packages/core/src/endpoint.ts` is
clean. No mutant residue.

## Why this is the lane's defect and not bad luck

**The lane knew `dist/` was shared and wrote the sentence itself.** From the guard comment at the top
of `connection-control.smoke.ts`:

> `dist/` is gitignored, so it is invisible to `git status`, invisible to the porcelain sweep, and
> **a SHARED SIDE EFFECT ACROSS WORKTREES: another lane's build changes what this suite executes.**

**It reasoned about that hazard in one direction only — inbound.** The guard protects *this suite*
from someone else's build. **Nothing protected anyone else from this suite's build.** The lane
modelled itself as a victim of a shared artifact and never as its author.

**The symlink is not what makes this wrong.** A mutation proof deliberately compiles a known-broken
artifact into a workspace-shared location. That is unsafe whether or not anyone happens to be
reading it, and "no one told me who else was loading it" is not a defence — it is the same
unestablished-subject error this lane has spent the day filing against others, pointed the other way.

## The correction to the method

**A mutation proof must build into a PRIVATE artifact, not a workspace-shared one.** The mutant
window is the one interval where a build is *intentionally* wrong, so it is exactly the case that
must never be reachable by anything but the proving suite. Options, unranked and unimplemented:

- build the mutant into a scratch `outDir` and point only the proving suite at it;
- run the proof in a throwaway clone whose `node_modules` no installed extension can reach;
- take an exclusive lock on `packages/core/dist` for the duration and verify no symlink resolves
  into this worktree before starting.

**None of these are implemented and this finding is NOT remediated.** Implementing any of them means
writing `packages/core/dist`, which is currently constrained pending David's ruling on the symlinks.

## What this does NOT claim

**It does not claim the mutant window caused any observed anomaly.** The fleet has spent the night on
erratic connect/spawn/despawn behaviour, and this window is a candidate cause with a name and a
timestamp — which is precisely why it should be tested rather than adopted. **An anomaly outside
`03:06:29Z`–`03:08:53Z` does not inherit this suspicion**, and one inside it is not thereby
explained.

The separate, larger fact stands on its own: since `03:08:53Z` the Claude and OpenCode seats load a
core carrying **nine unmerged connection-control commits** (`+562/−14` in `endpoint.ts`) while Codex
and Hermes seats load main's. **The fleet is running two different cores on the connect/spawn path
and it is not established which way the difference cuts** — every one of those nine is a *fix* for a
defect this lane reproduced, so the branch core may be better on these paths, not worse.
