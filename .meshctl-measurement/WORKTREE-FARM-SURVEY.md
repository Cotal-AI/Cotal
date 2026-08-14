# Which lane can execute what — a read-only survey of 49 worktrees

Run `Fri Aug 14 09:10:15 PM UTC 2026` (`date -u`, read at the moment of writing) from tip
`5317a2d4`. **Nothing was written to any tree but this one.** Commissioned by fm-orchestrator after
this lane hit a package it could not execute and reported it as a blocker rather than working
around it.

## Why it matters

> Every lane's "we did not measure X" list may contain items that are actually
> **"we CANNOT measure X here, and nobody knows it."**

Those two states are indistinguishable in every report produced so far, and they call for opposite
responses. A missing dependency does not announce itself — it presents as *your own probe being
broken*, which is how this lane first read it.

## Scope, stated rather than inherited from a glob

49 trees. Enumerated from `git worktree list` **plus** `~/Cotal-wt-*`, `~/cotal-worktrees/*`,
`~/[REDACTED-BOUNDARY-TERM]/cotal-wt/*`, `/tmp/*cotal*`, and the principal `~/Cotal`; deduplicated by
`readlink -f`; each confirmed to be a real checkout by the presence of `packages/core`. `/tmp/*Cotal*`
matched nothing and was checked separately rather than assumed.

## ⚠️ TWO INSTRUMENTS WERE BUILT AND BOTH WERE REFUTED BEFORE THE THIRD WORKED

Recorded because the failures are the same class this survey exists to find, and because the survey
would have shipped a confident wrong answer twice.

1. **Presence proxy** — "a package is executable if it has its own `node_modules`". **REFUTED by
   spot-check**: `rev-gate391-adversary/extensions/connector-core` has no `node_modules` and
   resolves `@cotal-ai/core` perfectly well, because the lookup walks *up* to the tree root. Node's
   algorithm is a walk, not a directory test. **Presence is not executability.**
2. **`import.meta.resolve(dep, parentURL)`** — the two-argument form is **ignored in Node 22**, so
   every specifier resolved relative to the survey script in `/tmp`. It reported **all 49 trees, the
   principal checkout included, as unable to resolve anything.** *A result too uniform to be true is
   the instrument confessing.* Only the built-in control caught it.
3. **Node's actual bare-specifier walk**, reimplemented — walk up from the package directory
   checking `<dir>/node_modules/<dep>/package.json`. **CONTROL: the principal checkout must come out
   fully resolvable, or the instrument is broken again.** It does. Results below are heterogeneous,
   which is the second tell that the instrument is live.

## Results

**30 fully resolvable · 4 PARTIAL · 15 with no executable package.**

### The 4 partial trees — the silent hazard

These look functional. They run most things. They fail on the one package a lane eventually reaches.

| Tree | Runnable / not | Cannot execute |
| --- | --- | --- |
| `Cotal-wt-fm-meshctl` (this lane) | 15 / 3 | `implementations/auth` (`@nats-io/jwt`, `@nats-io/jetstream`, `@nats-io/kv`, `@cotal-ai/workspace`), `implementations/web`, `packages/lang` |
| `Cotal-wt-rev2-meshctl-fix` | 1 / 17 | everything except `packages/core` — every extension and implementation is missing `@cotal-ai/core` |
| `Cotal-wt-wc-smoke` | 17 / 1 | `extensions/connector-core` (`@modelcontextprotocol/sdk`, `zod`) |
| `cotal-wt/rev-gate391-adversary` | 14 / 3 | `extensions/connector-core` (`@modelcontextprotocol/sdk`, `zod`), `implementations/web`, `packages/lang` |

**The sharpest consequence is `rev-gate391-adversary`: a REVIEW seat that cannot execute
`extensions/connector-core`.** A reviewer in that state cannot drive the connector at all, and
"could not reproduce" from it would read as a finding about the code rather than about the tree.

**`Cotal-wt-wc-smoke` is the shared-regime tree** fm-rebind flagged (its root `node_modules` is a
symlink to `~/Cotal/node_modules`) — and it *still* cannot execute `extensions/connector-core`,
because the shared root does not carry `@modelcontextprotocol/sdk` or `zod`. **Sharing the principal's
root is not the same as being complete.**

### The 15 trees where nothing executes

`Cotal-wt-rev-health`, `Cotal-wt-rev-meshctl-authority`, `Cotal-wt-rev2-meshctl-evidence`,
`cotal-wt/epmig-read`, `cotal-wt/rev-gate391-lifecycle`, `cotal-wt/wc-rev-authority`,
`cotal-wt/wc-rev2`, `cotal-worktrees/rev-rebind`, `cotal-worktrees/rev-rebind-fix`,
`/tmp/fma6-authz-tip`, `/tmp/fma6-authz-tip-2`, `/tmp/fmag-rev-authz-2-wt`, `/tmp/fmag-rev-authz-wt`,
`/tmp/fmag-rev-evidence-2.CJIU`, `/tmp/rev-subject-keying`.

These fail loudly on first use, so they are the *less* dangerous class.

**⚠️ THIS IS A SNAPSHOT AND MUST NOT BE READ BACKWARDS.** Three of these are this lane's own review
seats. **It does NOT follow that those seats could not run anything when they ran** — a teardown
after the fact produces exactly this state, and a teardown is known to have happened. What it does
say is that **anyone re-driving a verdict in one of those trees today will not be able to**, and
that a claim of "I drove it" from a currently-empty tree is worth a provenance question rather than
an accusation.

### Cross-tree resolution — code executing from another checkout

Five trees resolve at least one dependency outside themselves:
`Cotal-wt-wc-smoke` (18 packages), `Cotal-wt-fm-meshctl` (6), `Cotal-wt-rev2-meshctl-fix` (1),
`/tmp/fmag-rev-evidence-2.CJIU` (3), `/tmp/rev-join-security` (1).

**Including this lane.** Six packages here resolve `@nats-io/*` from `/home/david/Cotal`, because
`packages/core/node_modules` is a symlink into the principal checkout. Every core suite this lane
ran executed *its own* core source against the *principal's* nats client. Same version today;
**invisible if that ever stops being true**, and not something `git status` can show.

## What this does NOT establish

- **Executability, not correctness.** A resolvable dependency may still be the wrong version. Not
  measured.
- **A snapshot, not a history.** Says nothing about what any tree could do when its results were
  produced.
- **Declared dependencies only** — `dependencies` + `peerDependencies` from each `package.json`.
  A package importing something it never declared would pass this survey and still fail at runtime.
- **No tree was modified, and no missing dependency was installed.** The point was to find out who
  cannot measure what, not to fix it.
