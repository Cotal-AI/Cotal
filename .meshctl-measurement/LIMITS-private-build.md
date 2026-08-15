# What the private build closes, and what it does not

**Stamped `2026-08-15T06:4xZ` (`date -u` at writing), lane tip `a7743ea6`.**

Written because **a remedy whose limits are unstated gets cited later as though it had none.** The
private build (`packages/core/smoke/_core-entry.ts`, `mutation-proof --private-build`, verified by
`meshctl-m12-seam-control.mts`) closes one specific hole. It is narrower than its name suggests.

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

### 2. It does not cover `connection-lifecycle.smoke.ts`

That suite imports core as `../src/index.js` — **direct source, compiled in-memory by `tsx`.** It
never needed a build, which is why it does not have the seam and why widening it was explicitly not
done.

**The residual is real and stays named: a mutation in `packages/core/src` is a shared-tree mutation
the moment ANYONE runs `tsc`.** The mutant source sits in the tree for the length of the proof; any
concurrent build in this worktree — another lane's, a tool's, a habit — compiles it into the
fleet-linked dist. The proof itself never builds, so nothing in the proof is watching for that.

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

**Every Claude and OpenCode seat on this box still loads core from this lane's unmerged branch.**
The seam stops a *mutant* reaching them. It does nothing about the nine unmerged connection-control
commits they are already executing, which is a separate open question for whoever rules on the
links.

---

## The one-line version

**The private build closes this lane's mutation proofs' blast radius on `packages/core`. It does not
make the shared tree safe, does not survive an ordinary `tsc`, does not extend to other lanes or
packages, and does not detect anything.** Cite it for what it is.
