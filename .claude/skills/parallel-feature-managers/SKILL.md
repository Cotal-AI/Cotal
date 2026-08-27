---
name: parallel-feature-managers
description: Run several independent Cotal features concurrently by creating one Git worktree and one spawn-capable mesh manager per feature; each manager staffs a review panel in a dedicated channel, adds one independent cold reviewer briefed under the cold-review skill, owns plan-to-commit delivery, and escalates unresolved product decisions by DM to the coordinator for relay to the user. Use when the user asks to split multiple features across managers/worktrees, run parallel feature teams on Cotal, or have managers create their own review panels.
---

# Parallel feature managers

Use the live Cotal mesh as a hierarchy:

- The current session is the **coordinator**. It creates isolation, sets policy, monitors progress,
  and relays decisions. It does not duplicate implementation or panel review.
- Each feature gets one **manager** rooted in its own Git worktree and branch. The manager owns the
  complete plan -> implementation -> review -> test -> commit loop.
- Each manager spawns three or more **read/review-only peers** in one dedicated channel: engineer,
  security, and critic at minimum.
- Near the final gate, each manager adds one **independent cold reviewer**, briefed under the
  **`cold-review` skill**, which is the single source for how that seat is briefed, isolated and
  graded. It is a control on the panel rather than a fourth panelist.

## Models: cross-vendor panels are a correctness rule, not a preference

**No two seats whose agreement is load-bearing may share a model family.** A finding confirmed by a
seat of the same family as the one that made it is an echo, not a confirmation. A panel of three
same-model reviewers has approved a head carrying a defect that all three missed, and what surfaced
it was a differently framed read rather than a fourth verifier.

State it that way rather than as a headcount. **Availability is a property of the moment, not of the
vendor**: the same model has joined and delivered one hour and failed to join the next, on the same
host with the same tooling. A rule phrased as "N distinct vendors" is unsatisfiable on a degraded
fleet and silently so, and a rule that can be broken by the clock gets quietly ignored rather than
obeyed. `cold-review` carries the degradation order and the floor.

Pin the model explicitly at spawn AND in the persona, because unrecorded capability is
ungraded-in-effect: a reviewer whose effort or model nobody recorded produces a verdict nobody can
weigh afterwards.

Managers may run a stronger model than their reviewers. Reviewers should not run the same model as
the coordinator, so that the panel cannot inherit the coordinator's blind spots.

Verify the exact model identifiers against the connector's own catalog before spawning, and treat a
declared reasoning-effort tier as unverified until a seat has actually launched with it: a catalog
can declare tiers the provider refuses, and a refused tier kills the seat at launch.

## Hard rules

- Never switch the coordinator's branch. Create worktrees from a named committed base.
- One manager per feature, one reviewer per channel lane, and one independent DM-only reviewer per
  feature. No sibling instances or tester fan-out unless the user requests it.
- Managers alone edit their feature worktree. Reviewers only read, run non-mutating checks, and post
  findings with file/line references.
- Each feature uses one channel: `review.<feature-slug>`. Keep acknowledgements and status chatter
  off it; use it for plans, findings, reasoned dispositions, code-review requests, and final results.
- The independent cold reviewer is not on that channel. Its isolation, briefing and reporting are
  owned by `cold-review`; enforce them there rather than restating them per lane.
- Product/design decisions travel by DM: manager -> coordinator -> user -> coordinator -> manager.
  A manager must not guess through an unresolved consequential choice.
- Never merge, push, open a PR, or remove worktrees unless the user asks.
- Never disturb the live mesh broker. Tests use throwaway spaces and random high ports; kill test
  processes by exact PID, never broad `pkill`.

## 1. Establish the feature matrix

For every requested feature, choose and record:

| Field | Example |
|---|---|
| Feature | channels export |
| Slug | `channels-export` |
| Branch | `feat/channels-export` |
| Worktree | sibling path such as `Cotal-feature-channels-export` |
| Manager persona | `mgr-channels-export` |
| Channel | `review.channels-export` |
| Contract | concrete behavior, boundaries, tests, and known non-goals |

Resolve branch/path collisions before creating anything. Inspect `git status`, `git worktree list
--porcelain`, and existing branches. Do not clean or revert unrelated dirty state.

Create the worktrees sequentially because they mutate shared Git metadata:

```sh
git worktree add -b feat/<slug> /absolute/sibling/Cotal-feature-<slug> <base>
```

Use the same base commit for all features unless the user explicitly wants stacked work.

## 2. Make private repository context available

Before launch, verify each worktree can read `.internal/plans/STATUS.md` and the relevant guidelines.
Normally `git submodule update --init .internal` is sufficient.

If initialization fails because the superproject pins an unavailable commit:

1. Compare the committed pointer (`git ls-tree <base> .internal`) with the active local submodule
   HEAD (`git -C .internal rev-parse HEAD`). This is repository-state drift, not a Cotal ACL problem.
2. Prefer fixing/publishing the intended submodule commit and superproject pointer when authorized.
3. For a temporary parallel run, materialize the known-good local `.internal` commit independently
   into each feature worktree from the active local submodule repository.
4. Tell managers the superproject may show `M .internal`; they must read it but never stage, edit, or
   include it in feature commits.

Do not leave managers blocked merely because a fresh worktree cannot fetch a private commit that is
already available and verified locally. Do not pretend the mismatch is clean either; report the
permanent repair needed.

## 3. Create manager personas with policy first

Manager agents need `capabilities: [spawn]` plus channel ACLs. `cotal_persona` cannot grant policy,
so author `.cotal/agents/mgr-<slug>.md` before spawning. These files are local/ignored in this repo.

```yaml
---
name: mgr-<slug>
role: feature-manager
model: <pinned manager model>
description: Owns <feature> and its review panel.
tags: [manager, <slug>]
subscribe: [review.<slug>]
allowSubscribe: [review.<slug>]
allowPublish: [review.<slug>]
capabilities: [spawn]
---
```

The manager prompt must include all of the following:

- Exact feature contract, branch, and absolute worktree path.
- Own the feature end to end and commit only intended feature files.
- Read repo instructions, current docs, and `.internal` before editing.
- Join `review.<slug>` first.
- Spawn `review-engineer`, `review-security` and `review-critic`, **each on a different vendor's
  model**, each with its own detached worktree as `cwd`. A reviewer grades in its own tree, never in
  the tree it is grading, and "read-only" must name the git write verbs explicitly (`checkout`,
  `switch`, `stash`, `reset`, `clean`, `restore`) rather than only saying "do not edit source".
- DM each returned reviewer identity to join the channel and remain read/review-only.
- Run plan review before editing, code/test review after implementation, fold valid findings, and ask
  all three for a final disposition.
- After the panel and implementation converge, spawn exactly one `review-freelance` in its own
  detached worktree and brief it under the **`cold-review` skill**, which owns what that seat is
  given, where its verdict goes, what the verdict binds, and how the rules degrade when the vendor
  set is short. Do not restate any of it here.
- Fold or reason against the cold findings. **You may override a cold verdict only by publishing a
  refutation you verified yourself, and never by telling that seat to reconsider.** If you authored
  the change, you may not override it at all: fold, or escalate to a party who wrote nothing. If a
  fold changes code, return the result to the channel panel for another final pass and re-pin the
  cold seat to the new sha with its delivery limit explicitly reset in writing.
- Run the relevant tests itself. Reviewers do not edit source.
- Escalate only unresolved consequential choices with this exact structure:

```text
DECISION NEEDED: <one-line question>
Options: <A>; <B>; ...
Recommendation: <manager's recommendation and why>
Impact: <observable behavior / compatibility / risk>
Blocked: <what cannot proceed>; Continuing: <what can proceed>
```

- On completion, DM the coordinator the commit id, tests run, all three reviewer dispositions, and
  residual risks.

## 4. Seed channels and launch managers

Create the feature channel before inviting the team, with replay enabled and a short operator note.
Then spawn each manager through `cotal_spawn`:

```text
name: mgr-<slug>
role: feature-manager
agent: <connector>
model: <pinned manager model>
cwd: /absolute/path/to/feature-worktree
```

Launch managers in parallel only after all worktrees, personas, and channels exist. The manager may
auto-number repeated reviewer persona identities (`review-engineer-2`, etc.); track the returned
identity, not an assumed name.

Verify with `cotal_roster` that every manager appears and holds its full panel. Do not spawn
missing-looking duplicates prematurely; allow startup time and recheck first.

**A spawn that reports a timeout is not evidence the spawn failed.** It may already have succeeded,
and retrying submits a second goal that duplicates the effect. Read the outcome from the process
listing before acting, and never retry on a timeout alone.

**Verify a seat by REPLY, never by presence.** A seat can report as running and be silently
unreachable. Ask for a nonce artifact it must produce, such as an `echo` of a random token joined to
the short commit it is sitting on, and check the raw output. A handshake that states the expected
answer ("confirm you are at <path> on <sha>") is leading: an echo-compatible reply proves something
can mirror text, not that a shell ran.

The independent reviewer is intentionally absent during initial staffing. The feature manager spawns
it only at the cold-review gate, and runs it under the **`cold-review` skill**, which owns that
seat's isolation, briefing, and verdict rules. Do not restate them here: one source for the rule, or
the two copies drift and the stale one is invisible to whoever is editing the other.
Auto-numbering applies to `review-freelance` too, so track the returned identity.

## 5. Monitor without taking over

Join each review channel and set it `quiet`, so channel traffic is available on demand without
waking the coordinator. Keep DMs open: decisions and completion reports must wake the coordinator.

Use:

- `cotal_roster` for staffing and current activity.
- `cotal_inbox` for decisions, findings, and completions.
- Read-only `git status --short --branch` and `git log --oneline` in each worktree for branch state.

Do not redo the manager's implementation, review its diff in parallel, or send acknowledgement
noise. Intervene only for infrastructure, violated team policy, a real decision, or a stalled team.

When a manager sends `DECISION NEEDED`:

1. Check that existing code/docs/conventions do not already settle it.
2. Relay the concise options, recommendation, and impact to the user.
3. Wait for the user's choice; do not choose for them.
4. DM the decision back verbatim enough to preserve its constraints.
5. Record any cross-feature consequence and notify other affected managers privately.

Infrastructure blockers are coordinator work, not user decisions. Resolve worktree, submodule,
dependency, or mesh-access issues directly when safe.

## 6. Completion gate

A feature is complete only when:

- The manager has folded or reasoned against every concrete finding.
- Every panel reviewer gives final approval, and **no two reviewers whose agreement is load-bearing
  share a model family**. "Spans more than one vendor" is NOT this condition: a panel staffed A, B, A
  satisfies it and violates the rule, and an A-A pair is the same-family echo the rule exists to
  reject. Where the vendor set is too short, name the collision mechanically and the failure class it
  leaves uncovered, per `cold-review`.
- The independent cold reviewer gives final approval, posted **by that seat itself** to the
  destination its brief named, naming the exact sha, without having joined the panel channel and
  without having been shown the panel's findings. A verdict relayed by the manager does not satisfy
  this, and the manager verifies it landed by re-fetching the destination.
- Every approval names the head it graded, and that head is re-resolved at merge time. A verdict is
  never carried across a sha. Both are steps in the loop above, not assertions made here.
- Required focused and integration tests pass.
- The feature is committed on its own branch.
- `git status` is clean except an explicitly acknowledged local `.internal` pointer mismatch.
- The completion DM includes commit, tests, approvals, and residual risk.

Park completed teams until integration is requested. Report progress to the user as a compact matrix:
completed commit, in-review findings, implementing, or decision needed.

## 7. Integrate and clean up only on request

When asked to land the work, inspect all feature commits and expected shared-file conflicts first.
Parallel features commonly touch `docs/cli.md`, generated docs bundles, `package.json`, flag
inventories, and changesets. Merge/cherry-pick deliberately, resolve by preserving both behaviors,
then run the aggregate gate once on the integrated result and request a final cross-feature review
when conflicts changed code.

After landing and verification:

1. `cotal_despawn` the three panel reviewers, independent reviewer, and manager for each feature.
2. Remove only clean, landed worktrees and their branches according to the user's cleanup request.
3. Leave reusable base reviewer personas in `.cotal/agents/`; remove throwaway manager personas only
   if they are no longer useful.
4. Restore channel attention/subscriptions if desired.

Never tear down peers before their final result is captured, and never remove an unmerged worktree.
