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
- One manager per feature, one reviewer per channel lane, and one independent cold reviewer per
  feature. Select that seat's contact and destination under `cold-review`. A file destination is a
  norm-only fallback and cannot satisfy a gate that requires broker-attested poster identity. No
  sibling instances or tester fan-out unless the user requests it.
- Managers alone edit their feature worktree. Reviewers only read, run non-mutating checks, and post
  findings with file/line references.
- Each feature uses one panel channel, `review.<feature-slug>`, plus one dedicated cold record channel,
  `review.<feature-slug>.cold-record`. Keep acknowledgements and status chatter off the panel channel;
  use it for plans, findings, reasoned dispositions, code-review requests, and final results.
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
| PR | exact number, or `none` until one exists |
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

## 3. Create manager and reviewer personas with policy first

Manager agents need `capabilities: [spawn]` plus channel ACLs. Reviewer agents need channel ACLs and
must not have spawn. `cotal_persona` cannot grant policy, and `cotal_spawn` cannot override
`allowSubscribe` or `allowPublish`, so author every persona file before spawning. These files are
local/ignored in this repo. A clean machine that has only a default persona cannot staff the panel:
the spawn names below fail unless those files exist, and a leftover local persona is not a
substitute because its grants may be missing or wider than the lane.

```yaml
---
name: mgr-<slug>
role: feature-manager
model: <pinned manager model>
description: Owns <feature> and its review panel.
tags: [manager, <slug>]
subscribe: [review.<slug>]
allowSubscribe: [review.<slug>, review.<slug>.cold-record]
allowPublish: [review.<slug>]
capabilities: [spawn]
---
```

Author matching files for the three panel seats and the cold seat before any spawn. Give every
reviewer persona a lane-scoped filename such as `review-<slug>-engineer`; the persona catalog is
shared by concurrent lanes, so generic filenames collide even when the worktrees and channels do
not. Panel personas subscribe and publish only on `review.<slug>`. The cold persona lists empty
subscribe and allowSubscribe so non-join is a property of the seat, not an instruction, and may
publish only to `review.<slug>.cold-record`. Do not reuse or redefine a reviewer persona from another
lane.

```yaml
---
name: review-<slug>-engineer
role: reviewer
model: <pinned panel model, family A>
subscribe: [review.<slug>]
allowSubscribe: [review.<slug>]
allowPublish: [review.<slug>]
capabilities: []
---
```

```yaml
---
name: review-<slug>-freelance
role: reviewer
model: <pinned cold model, not the author's family>
subscribe: []
allowSubscribe: []
allowPublish: [review.<slug>.cold-record]
capabilities: []
---
```

Repeat the panel template for `review-<slug>-security` and `review-<slug>-critic` with different model
families. If a referee is later required, author `review-<slug>-referee` the same way as the cold seat,
with empty subscribe and allowSubscribe plus one dedicated record-channel allowPublish grant, before
spawning it.

The manager prompt must include all of the following:

- Exact feature contract, branch, and absolute worktree path.
- Own the feature end to end and commit only intended feature files.
- Read repo instructions, current docs, and `.internal` before editing.
- Join `review.<slug>` first.
- Spawn only personas authored in this section. Spawn `review-<slug>-engineer`,
  `review-<slug>-security`, and `review-<slug>-critic`, seated so that **no two of them whose agreement
  is load-bearing share a model family**. That is the ordinal rule above and not a headcount. Where the vendor set is short, name
  the collision mechanically and the class it leaves uncovered. **Naming is disclosure, not
  completion:** a panel whose load-bearing approvals are same-family echoes cannot complete, including
  A, A, A and A, B, A. Do not treat a staffed-but-collided panel as a passing gate. Give each its own
  detached worktree as `cwd`. A reviewer grades in its own tree, never in the tree it is grading, and
  "read-only" must name the git write verbs explicitly (`checkout`, `switch`, `stash`, `reset`,
  `clean`, `restore`) rather than only saying "do not edit source".
- DM each returned reviewer identity to join the channel and remain read/review-only.
- Run plan review before editing, code/test review after implementation, fold valid findings, and ask
  all three for a final disposition.
- After the panel and implementation converge, spawn exactly one `review-<slug>-freelance` in its own
  detached worktree and brief it under the **`cold-review` skill**, which owns what that seat is
  given, where its verdict goes, what the verdict binds, and how the rules degrade when the vendor
  set is short. Do not restate any of it here.
- Resolve cold findings under `cold-review`'s canonical rule, never by telling that seat to
  reconsider. If the manager authored the change and a blocker needs independent refutation, send the
  coordinator only the exact-sha finding and artifact. The coordinator provisions a fresh
  `review-<slug>-referee` in its own detached worktree; that seat had no part in authoring, grading or
  supervising the lane, does not share a model family with the author, and receives none of the
  author's rationale. The coordinator provisions the
  referee but does not serve as it. If a fold changes code, return the result to the channel panel for
  another final pass and re-pin the cold seat to the new sha with its delivery limit explicitly reset
  in writing. If that seat is gone, author a fresh cold persona with empty subscribe and
  allowSubscribe plus only its dedicated record-channel allowPublish grant, spawn it, and brief it
  under `cold-review` on the new sha as a new one-delivery seat. That is a successor, not a third
  closure route for the old sha.
- Re-resolve the head as an action, not as a later assertion. At briefing, at any completion claim,
  and again before merge, the manager or coordinator first resolves the review target. For a PR, run
  `git ls-remote origin refs/pull/<n>/head` and cross-check `gh pr view <n> --json headRefOid`. For a
  branch with no PR, resolve `git ls-remote origin refs/heads/<branch>` and omit the PR-only API
  cross-check. Fetch the resolved object into the detached review worktree if it is not already
  present, then run `git cat-file -t` on that object with a known-good control and a known-missing
  full-width object id, such as forty zeroes, that must fail. Do not make the negative control by
  appending a character to the real id: Git may resolve the valid leading object id and return
  success. Name the actor who ran the instruments. If applicable instruments disagree, stop.
  A verdict or refutation that names a different sha does not close this head.
- Run the relevant tests itself. Reviewers do not edit source.
- Escalate only unresolved consequential choices with this exact structure:

```text
DECISION NEEDED: <one-line question>
Options: <A>; <B>; ...
Recommendation: <manager's recommendation and why>
Impact: <observable behavior / compatibility / risk>
Blocked: <what cannot proceed>; Continuing: <what can proceed>
```

- On completion, DM the coordinator the commit id, tests run, all three panel dispositions, the
  terminal cold verdict and any public refutations, and residual risks.

## 4. Seed channels and launch managers

Create the panel channel and dedicated cold record channel before inviting the team, with replay
enabled and a short operator note. Then spawn each manager through `cotal_spawn`:

```text
name: mgr-<slug>
role: feature-manager
agent: <connector>
model: <pinned manager model>
cwd: /absolute/path/to/feature-worktree
```

Launch managers in parallel only after all worktrees, personas, and channels exist. Track the
returned reviewer identity, not an assumed name; a restarted or duplicated launch may still be
auto-numbered even though the persona filename is lane-scoped.

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
it only at the cold-review gate, and **briefs it by applying the `cold-review` skill itself**: that
file addresses the briefer, and the graded seat never loads it. It owns that seat's isolation,
briefing, and verdict rules. Do not restate them here: one source for the rule, or the two copies
drift and the stale one is invisible to whoever is editing the other.
Auto-numbering applies to the lane-scoped cold persona too, so track the returned identity.

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

- The manager has folded or reasoned against every **panel** finding. Cold findings are governed
  only by the dedicated closure rule below; this bullet must not privately override them.
- Every panel reviewer gives final approval, and **no two reviewers whose agreement is load-bearing
  share a model family**. "Spans more than one vendor" is NOT this condition: a panel staffed A, B, A
  satisfies it and violates the rule, and an A-A pair is the same-family echo the rule exists to
  reject. Where the vendor set is too short, name the collision mechanically and the failure class it
  leaves uncovered, per `cold-review`. **A named collision is not a third completion path.** If the
  remaining load-bearing approvals share a family, the feature is not complete. Refuse below that
  floor rather than recording a same-family panel as reviewed.
- **A terminal cold verdict landed first-hand before finding closure is evaluated:** APPROVE or named
  blockers at the exact sha, at the destination the brief named. A silent, failed, or non-verdict cold
  lifecycle is not completion. On the broker-attested route, the cold persona has empty subscribe and
  allowSubscribe, may publish only to its dedicated record channel, and panel personas may not read
  it. A file is a norm-only fallback and cannot satisfy a gate requiring broker-attested poster
  identity.
- **After that terminal verdict exists, every cold blocker is closed**, by one of exactly two routes
  and no third: the cold seat posted APPROVE at the exact sha; **or** each blocker at that sha was
  answered by a public refutation from a
  permitted party under `cold-review`'s override rule, naming the same exact sha and left standing in
  the record beside the finding. **An unanswered cold blocker is neither, and is not completion.**
  Requiring the seat's own approval *alone* would deadlock the override the first time it was used
  correctly: the seat is one-delivery and may never be told to reconsider, so a refuted blocker could
  be cleared only by changing code to satisfy a finding just publicly refuted, or by a zero-delta
  re-pin to manufacture an approval, which is laundering. The override answered the question and the
  gate has to let the answer count.
- A verdict relayed by the manager satisfies nothing, and the manager confirms the seat's own post
  landed by re-fetching the destination. The sha and destination are retrospective evidence. A post
  on the dedicated Cotal record channel also attests the cold seat's principal. A GitHub comment
  attests only a GitHub account and is not cold-seat evidence when the workstation credential is
  shared. Historical non-join is auditable only from retained launch-time ACL evidence; a current
  subscription snapshot is not proof. For a file destination, poster is a **norm**: the file's
  presence does not prove the seat wrote it. That the brief carried no findings is also a **norm**
  resting on the briefer, so it is deliberately not a gate condition here; listing a norm in the
  grammar of a control is the false assurance `cold-review` exists to prevent.
- Every approval and public refutation names the exact head it grades or answers. The manager or
  coordinator re-resolves that head at briefing, at the completion claim, and again at merge, using
  the instruments in the manager prompt: Git ref and object type for every lane, plus the exact PR
  API cross-check when a PR exists. Neither a verdict nor a refutation is ever carried across a sha.
- Required focused and integration tests pass.
- The feature is committed on its own branch.
- `git status` is clean except an explicitly acknowledged local `.internal` pointer mismatch.
- The completion DM includes commit, tests, panel approvals, the terminal cold verdict and any public
  refutations, and residual risk.

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
3. Remove lane-scoped reviewer and manager personas only if they are no longer useful.
4. Restore channel attention/subscriptions if desired.

Never tear down peers before their final result is captured, never remove an unmerged worktree, and
do not delete the dedicated cold record channel or its retained verdict history as routine cleanup.
