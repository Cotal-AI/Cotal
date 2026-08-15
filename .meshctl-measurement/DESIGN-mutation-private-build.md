# Mutation proofs must build into a private artifact — design, UNIMPLEMENTED

**Stamped `2026-08-15T05:3xZ` (`date -u` at writing), lane tip `a9676eb5`.**
**DESIGNED, NOT APPLIED.** Applying any of this writes `packages/core/dist`, which is constrained
pending a ruling on the extension symlinks. Nothing here has been executed; the one place a claim
rests on reasoning rather than a command is marked **UNVERIFIED** in place.

Companion to `FINDING-mutation-on-shared-dist.md`, which records what happened. This note is what
should be true instead.

---

## 1. The mechanism: where a mutant build goes

### The constraint that shapes it

A mutation proof is a four-step cycle — **build mutant → run suite → restore source → rebuild** — and
steps 1 and 4 both write a compiled artifact. Today both write `packages/core/dist`, which is:

- resolved by the bare specifier `@cotal-ai/core` from anywhere in the workspace, and
- resolved by **two installed connector extensions**, via symlinks the lane could not see.

So the mutant is not merely *visible* to other readers — it is the artifact they execute.

**`pnpm install` is forbidden in this repo's working agreements**, which rules out the obvious fix of
a throwaway clone with its own `node_modules`. The design has to work without one.

### The shape

**Build the mutant to a scratch `outDir` that did not exist until this run created it, and let only
the proving suite resolve it.**

```
1. scratch=$(mktemp -d)                      # a path nothing else can already reference
2. tsc -p packages/core --outDir "$scratch"  # mutant compiles HERE; shared dist untouched
3. COTAL_CORE_ENTRY="$scratch/index.js" tsx <proof-suite>
4. rm -rf "$scratch"                         # nothing to restore, because nothing shared was written
```

Step 4 is the point: **there is no restore step, because there was no mutation of anything shared.**
The write-then-undo window — the interval this lane actually injected a defect in — **does not
exist in this design.** That is the property to preserve; everything else is mechanism.

### How the suite points at it

The proving suite must resolve core through a seam it controls rather than through the bare
specifier. Minimal change, and it keeps the default honest:

```ts
// Default is the SHARED build, so an ordinary run still grades what users actually execute.
// A mutation proof — and only a mutation proof — redirects to its own private build.
const CORE_ENTRY = process.env.COTAL_CORE_ENTRY ?? "@cotal-ai/core";
const { isReachable, /* … */ } = await import(CORE_ENTRY);
```

Two properties worth stating because they are easy to lose:

- **The default path is unchanged.** A normal suite run still resolves `@cotal-ai/core` and still
  grades the published entry point. This does not trade a provenance gap for a coverage gap — the
  objection the existing guard comment already raises against pointing imports at `src/`.
- **The redirect is explicit and per-run.** An absent env var cannot silently select a private
  build, so the failure mode is "the proof graded the shared build" — loud and wrong in the safe
  direction — rather than "an ordinary run graded a mutant".

**UNVERIFIED:** that `tsc -p packages/core --outDir <scratch>` produces a loadable tree under this
project's `rootDir`/`composite` settings has **not been executed**, because running it writes a
build. It is the first thing to check when the constraint lifts, and it is the only step here that
could fail on contact.

### The freshness guard under this design

The existing guard compares `dist` mtime against `packages/core/src` mtimes and **throws**. It stays
exactly as it is for ordinary runs. Under a private build the guard should compare against the
**scratch** output instead — same question, different subject — so that a proof cannot grade a
private build that failed to compile.

---

## 2. What the guard should have asked — and the answer is that it cannot

The current guard asks **"is my build output stale?"** The question that would have caught this is:

> **"Is anything outside this worktree resolving my build output?"**

**That question is not answerable from inside the worktree. This is the finding, not a caveat.**

Measured, not reasoned:

| probe | result | what it means |
| --- | --- | --- |
| `stat -c %h packages/core/dist/endpoint.js` | **`1`** | the two inbound symlinks are **invisible** to the target — a symlink does not increment its target's link count, and the filesystem keeps **no reverse reference** |
| `lsof packages/core/dist/endpoint.js` | **empty** | Node reads a module and closes the descriptor; a steady-state open-file check cannot find resolvers either |
| directed scan of `~/.config/cotal` + `~/.local/share/cotal` for symlinks resolving into this worktree | **2 found** | it works **only because the roots were already known** |

The scan found the real links — and that is exactly why it is a trap. **A scan can prove presence and
can never prove absence.** The search space is every path on the filesystem, plus `NODE_PATH`, plus a
pnpm store hardlink, plus a plain `cp -r` of the build that no link would reveal at all. A clean scan
means *"I did not find one where I looked"*, and this lane has already filed that exact defect
against its own leak scanner: **a CLEAN that cannot fail is not a result.**

**So the fix cannot live in a guard that checks who reads the artifact.** No amount of care at the
write site can enumerate the read sites. It has to live in never writing a shared artifact at all —
which is what §1 does, and why §1 is a design change rather than a new check.

**Corollary for whoever owns the load path:** the reverse question *is* answerable from the other
side. An installer that symlinks a package into an unmerged worktree knows it is doing so at the
moment it does it. **The detection belongs where the link is created, not where it is pointed** —
and that is a different lane's surface, recorded here rather than fixed here.

---

## 3. The general form

Written for a lane with no knowledge of tonight.

> **Never mutate an artifact you do not exclusively own.**
>
> A verification method that deliberately breaks a shared artifact is a method that can inject that
> defect into everything resolving it. The failure is not noticed by the lane doing it, because the
> lane is watching its own suite go red on purpose — **a mutant that "works" looks identical to a
> mutant that escaped.**
>
> The discipline is **not** "check who else reads it before you break it". That check cannot be
> completed: the filesystem keeps no reverse index of symlinks, open-descriptor inspection misses
> anything not currently reading, and a copy leaves no trace at all. **The discipline is exclusivity
> by construction — write only to a path that did not exist until this process created it.**
>
> A useful test when designing any destructive verification: **name the interval during which the
> shared thing is wrong, and name who could observe it in that interval.** If the second answer is
> "I would have to go and find out", the design is already wrong — not because the answer is bad,
> but because it is a question you cannot finish asking.

### Applies beyond compiled output

The same shape covers anything a proof deliberately corrupts to see who notices: a fixture database,
a shared scratch directory, a checked-out branch in a worktree others resolve, a broker's stored
state, an installed extension. **Compiled `dist` is simply the case where the blast radius is "every
process that imports it" and the window is "until you rebuild".**

### What this does not say

It does not say shared artifacts are unsafe to *read*, or that builds must be private in general.
Ordinary builds are fine — they make the shared artifact **different**, and the workspace already
expects that. **Mutation makes it deliberately wrong**, and that is the distinction the rule turns
on. A ruling about rebuilds would not reach this case.

---

## Status

**UNIMPLEMENTED.** Implementing §1 requires writing `packages/core/dist` at least once to verify the
scratch build loads, which the current constraint forbids. When it lifts, the order is: verify the
`--outDir` build loads (the one UNVERIFIED claim above), add the `COTAL_CORE_ENTRY` seam, move the
mutation procedure onto it, and delete the restore step — **the restore step's absence is the proof
the design worked.**
