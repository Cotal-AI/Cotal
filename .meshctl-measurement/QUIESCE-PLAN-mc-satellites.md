# Standing down the six `mc-*` satellites — a plan, WRITTEN AND NOT EXECUTED

**Stamped `2026-08-15T08:52Z` (`date -u` read at writing). Lane tip `b6d54959`.**
**NOTHING IN THIS FILE HAS BEEN RUN.** Every command below is proposed. What *was* run is the
measurement in §1, which is read-only: `readlink`, `find -type l`, `git rev-parse`, `git status`.
**No build, no `pnpm`, no broker, no window, and no process-listing capture** — this document quotes
no process arguments and names no seat's prompt content, by standing instruction.

Written on fm-orchestrator's offer at release ("a quiesce plan for those six — written, not
executed — would be genuinely useful and needs no window, no build and no box time").

---

## 0. The one thing to read if you read nothing else

**The six satellites are downstream of THIS lane's worktree, not of the principal checkout.** Every
one of them resolves its dependencies through
`/home/david/Cotal-wt-fm-meshctl/node_modules`. **So the hazard is not that they hold something
dangerous — it is that removing this lane's worktree first would break all six at once**, silently,
at the next resolution. **Order matters, and it is the only thing here that does.**

---

## 1. What is actually there — measured, not recalled

### 1.1 The worktrees

| worktree | HEAD | dirty | ancestor of `origin/main` | ancestor of this lane's tip `b6d54959` |
| --- | --- | --- | --- | --- |
| `Cotal-wt-mc-authority` | `66bb07d1` | 0 | no | **yes** |
| `Cotal-wt-mc-cleanup` | `9243a45b` | 0 | no | **yes** |
| `Cotal-wt-mc-e2e` | `66bb07d1` | 0 | no | **yes** |
| `Cotal-wt-mc-evidence` | `66bb07d1` | 0 | no | **yes** |
| `Cotal-wt-mc-refusal` | `66bb07d1` | 0 | no | **yes** |
| `Cotal-wt-mc-supervisor` | `66bb07d1` | 0 | no | **yes** |

**This is the fact that makes removal cheap: no commit is only reachable from a satellite.** All six
detached HEADs are ancestors of `feat/agent-connection-control`, checked with `git merge-base
--is-ancestor <head> b6d54959` per worktree. **Removing all six loses no history.**

**Every tree is clean** (`git status --porcelain` → 0 lines). There is no uncommitted review work to
rescue.

### 1.2 The stash is ONE object, not six — do not read the per-worktree listing as six stashes

`git stash list` inside each satellite reports 1 entry. **It is the same entry.** `refs/stash` is
repository-wide, not per-worktree:

```
mc-authority   12ac8476864617cb6457bebb171fe6f1a68ad677
mc-cleanup     12ac8476864617cb6457bebb171fe6f1a68ad677
mc-e2e         12ac8476864617cb6457bebb171fe6f1a68ad677
fm-meshctl     12ac8476864617cb6457bebb171fe6f1a68ad677
```

**A per-worktree command that reads a shared ref reports the shared thing once per caller.** Anyone
quiescing these seats who counts stashes per worktree will conclude six seats have unsaved work and
will not delete anything. **Nobody should drop that stash as part of this plan** — its owner is not
established here, and it is not a satellite's.

### 1.3 The links, exactly

**Five satellites: one link each.**

```
Cotal-wt-mc-{authority,e2e,evidence,refusal,supervisor}/node_modules
        -> /home/david/Cotal-wt-fm-meshctl/node_modules
```

**`mc-cleanup`: nineteen links, all into this lane's worktree** — the root plus eighteen
package-level ones (`packages/{core,workspace,lang}`, `implementations/{auth,cli,web,manager,
delivery}`, `extensions/{connector-core,connector-claude-code,connector-opencode,connector-codex,
connector-hermes,pi,cmux,tmux,orca,herdr}`), each `.../<pkg>/node_modules ->
/home/david/Cotal-wt-fm-meshctl/<same path>`.

**Local build output exists in exactly two of them**: `mc-authority` and `mc-cleanup` each have a
real `packages/core/dist/` (gitignored, present). The other four have none. That output is theirs
alone — nothing outside them resolves it (§1.5) — so it dies with the worktree and needs no
handling.

`mc-cleanup` also carries a `.cotal/` anchor directory. **Per Cotal #419 that anchor is inert on
this box while `~/.cotal/current-mesh` is set, so its presence grants nothing and its removal takes
nothing away.** It is listed because it exists, not because it protects.

### 1.4 🔴 A DISCREPANCY I AM REPORTING RATHER THAN RESOLVING

**fm-orchestrator holds, and told me not to touch, "`mc-cleanup`'s five links into the principal
checkout".** I cannot find them.

```
for w in mc-authority mc-cleanup mc-e2e mc-evidence mc-refusal mc-supervisor; do
  find "/home/david/Cotal-wt-$w" -xdev -type l -exec sh -c 'readlink "$1"' _ {} \;
done   |  grep '^/home/david/Cotal/'      ->  NO MATCHES
```

**Zero symlinks under any of the six resolve into `/home/david/Cotal`.** All nineteen of
`mc-cleanup`'s links resolve into this lane's worktree. I checked raw link text as well as resolved
paths, because a raw target of the `/home/david/Cotal/./node_modules` shape is the exact trap
fm-webconsole flagged — and there are none of those either.

**Links into the principal checkout DO exist on this box, in a different subject:** the installed
extension layer, `~/.config/cotal/extensions/node_modules/@cotal-ai/*/node_modules/@cotal-ai/core`.
Nine links; three point at `/home/david/Cotal/packages/core` (`connector-codex`,
`connector-hermes`, `pi`), two at this lane, three at `Cotal-wt-meshctl-e2e`, one at
`Cotal-wt-fm-health`. **Three, not five, and they are not `mc-cleanup`'s worktree.**

**Three readings were offered and none chosen. RESOLVED 2026-08-15T09:1xZ, and none of the three was
right** — fm-orchestrator measured it independently and so did I.

**The five exist. They are `mc-cleanup`'s RESOLVED TARGETS, not its links.** The hop that names the
principal is in THIS lane's worktree:

```
mc-cleanup implementations/{manager,cli,delivery}/node_modules   -> here -> PRINCIPAL
mc-cleanup packages/{core,workspace}/node_modules                -> here -> PRINCIPAL
                                                                    ^^^^ the naming hop is MINE
```

**Five, `packages/core` among them — the count was right and the attribution was wrong.** Both
statements in §1.4's opening are therefore true and not in conflict: not one satellite link *names*
the principal, and five of them *reach* it.

### And the instrument could not have seen it, which is the transferable part

**This lane scanned the six satellites. The principal-naming links are in the SCANNER'S OWN TREE**,
which was never a subject of the scan.

> **An instrument that takes "the others" as its subject cannot report on the one running it.**
> Same family as a process check that matches the checker, inverted: not a subject contaminating the
> instrument, but **an instrument whose scope silently omits itself.**

### 🔴 What this worktree actually holds — measured, and NOT to be acted on

**Six `node_modules` symlinks in this lane's own tree point DIRECTLY at the principal** (6 at
maxdepth 4, 6 at any depth — the bound hides nothing): `bin`, `implementations/{cli,delivery,
manager}`, `packages/{core,workspace}`. **`packages/core` — the package this branch's containment
work is built on — is one of them.** A `pnpm` script invoked at any of those six is a delete path
against the **live checkout's** modules; the no-TTY abort is what stops it, and `CI=true` disables
the abort.

**One hop further, and it goes the other way too:** 61 symlinks inside the principal climb back into
this worktree, 21 first-party, 13 in the binary's composition root. Recorded in
`LIMITS-private-build.md` #5.

**Standing order: nothing here is repointed, removed or tidied, including the installed-extension
layer.** They are load-bearing for whatever installed them, and that is not established.

### 1.5 Does anything resolve INTO the satellites? Directed scan says no. That is not "nothing does."

A scan of the install roots and every sibling worktree, to depth 4, for symlinks whose target
mentions `Cotal-wt-mc-`, returned **no hits**.

**This is presence-only evidence and the limit is already a finding of this lane**
(`DESIGN-mutation-private-build.md` §2): the filesystem keeps no reverse index of symlinks, so
**a clean scan means "not found where I looked", never "nothing points here".** A `cp -r`, a path in
an environment somewhere, or a link outside the scanned roots would leave no trace this could find.
**Do not upgrade this row to "safe to delete" — it is "no reason found not to".**

---

## 2. The plan

**Preconditions, all of which must hold at execution time and none of which hold by assumption:**

- fm-orchestrator has released the satellites for stand-down (they were frozen for the MX16 window;
  **frozen is not stood down**, and the freeze may have been lifted without this being intended).
- §1.4 is answered by whoever holds it.
- **No satellite is running.** Establishing that is the executor's problem and it is not solvable by
  a pattern match: `pgrep -f mc-authority` matches the checker itself and anything merely mentioning
  the name. Walk `/proc/*/cwd` for a satellite path, excluding the checker's own pid, or ask each
  seat on the mesh and take silence as unknown rather than as absent.

### Step 1 — quiesce the seat, not the directory

For each satellite, in any order; they are independent of each other.

1. **Ask the seat to stand down on the mesh and wait for its own acknowledgement**, so the roster
   loses it as a departure rather than as a silence. This lane's whole subject is that **a seat that
   goes away while still on the roster is a ghost**, and the ghost cost on this program is already
   paid and documented. **Deleting a worktree under a live seat manufactures exactly that.**
2. Only then confirm the process is gone by the `/proc` walk above.

**Verified by:** the roster no longer lists the seat, *and* no `/proc` entry has that worktree as
its cwd. **Either alone is insufficient** — the roster has served a stale presence view from cache
for fourteen hours on this box, and a missing process is not a departed member.

### Step 2 — remove the worktrees, satellites FIRST

```
git -C /home/david/Cotal worktree remove /home/david/Cotal-wt-mc-<name>
```

**Order: all six satellites before this lane's worktree is touched, and this lane's worktree is not
part of this plan.** Reverse that order and the six lose their `node_modules` target with no error
until the next resolution, which is a broken seat that looks like a broken build.

`git worktree remove` refuses on a dirty tree; all six are clean, so **a refusal here means the tree
changed since §1.1 was measured, and the correct response is to stop and re-measure, not to pass
`--force`.** That refusal is the only interlock this step has.

**No commit is lost** (§1.1), so no branch needs creating first. **No `rm -rf`** — `git worktree
remove` also clears the administrative entry under `.git/worktrees`, which a manual delete leaves
behind as a stale registration.

**Verified by:** `git worktree list` no longer names the path; the directory is gone; **and
`git rev-parse 66bb07d1^{commit}` still resolves from the principal checkout** — the positive
control that removal took the worktree and not the history.

### Step 1.5 — WHAT GOES WRONG IF THIS IS DONE IN THE WRONG ORDER, per satellite

**Added because a plan that gives an order without the failure it prevents gets reordered by the
first person under time pressure.** Each row is the *observable*, because the failures here do not
announce themselves as ordering failures.

| satellite | wrong order | what actually goes wrong | how it presents to whoever is looking |
| --- | --- | --- | --- |
| all six | **this lane's worktree removed before the satellite** | its `node_modules` target vanishes; the link stays, now dangling | **`ERR_MODULE_NOT_FOUND` on a bare specifier, on unchanged source.** Reads as a broken install and invites a `pnpm install`, which is forbidden here and would repopulate a directory six trees resolve |
| all six | **worktree removed before the seat is stood down** | the seat's cwd is unlinked underneath it; it keeps running | **a ghost: present on the roster, no working tree.** Its next file read fails in a way its own logs attribute to the repo, and its DMs still route to it |
| `mc-cleanup` | **root link cleared, package-level links left** | eighteen package-level links still resolve into this lane; root resolution no longer does | **partial resolution** — some imports work, some do not, in the same process. Worse than total failure, which at least stops |
| `mc-authority`, `mc-cleanup` | **removed while their local `packages/core/dist` is assumed shared** | nothing; their dist is theirs alone (§1.5 found nothing resolving into them) | **no observable.** Listed so nobody preserves it "just in case" and leaves a worktree standing for a copy of a build |
| any | **`rm -rf` instead of `git worktree remove`** | the administrative entry under `.git/worktrees` survives | `git worktree list` reports a path that does not exist; **`git worktree add` later refuses the name**, with an error about the wrong thing |
| any | **the shared stash dropped as "the satellite's unsaved work"** | it is one repository-wide object (§1.2), not that satellite's | **whoever owns it loses it silently**, and the loss is attributed to a seat that never had it |

**The single sentence, if the table is skipped: nothing in step 2 fails loudly at the moment the
order is broken.** Every failure above surfaces later, somewhere else, as a different kind of
problem — which is precisely why the order is written down.

### Step 3 — the links need no separate step, and here is why that is not an oversight

Every link measured in §1.3 lives **inside** a satellite worktree. Removing the worktree removes
them. **There is no cleanup pass, because there is no link outside the deleted trees** — that is
what §1.3 and §1.4 establish, and it is the reason §1.4 has to be answered first: if the five
principal links do exist somewhere outside these trees, **this step is wrong and step 2 will leave
them dangling.**

**The installed-extension links in §1.5 are NOT in scope.** Three of them point at this lane's or
`meshctl-e2e`'s unmerged worktree and are a live open decision (register item 2, the human's).
**Touching them from a cleanup plan would be deciding that item by side effect.**

---

## 3. What this plan does not do

- **It does not run.** Nothing above has been executed.
- **It does not touch the five links fm-orchestrator is holding**, whatever they turn out to be.
- **It does not prove the satellites are unreferenced** (§1.5), only that a directed scan found no
  referent.
- **It does not stand down this lane's own worktree**, which the six depend on and which is still
  carrying an open branch.
- **It says nothing about whether the satellites' work is finished.** Their HEADs are ancestors of
  this lane's branch, so their *commits* are safe; whether their *reviews* concluded is a question
  for their verdicts, not for the filesystem.
