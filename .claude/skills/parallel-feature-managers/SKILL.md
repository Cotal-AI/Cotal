---
name: parallel-feature-managers
description: Run several independent Cotal features concurrently by creating one Git worktree and one spawn-capable mesh manager per feature; each manager staffs exactly three OpenCode gpt-5.6-sol high reviewers in a dedicated channel plus one DM-only independent cold reviewer, owns plan-to-commit delivery, and escalates unresolved product decisions by DM to the coordinator for relay to the user. Use when the user asks to split multiple features across managers/worktrees, run parallel feature teams on Cotal, or have managers create their own review panels.
---

# Parallel feature managers

Use the live Cotal mesh as a hierarchy:

- The current session is the **coordinator**. It creates isolation, sets policy, monitors progress,
  and relays decisions. It does not duplicate implementation or panel review.
- Each feature gets one **manager** rooted in its own Git worktree and branch. The manager owns the
  complete plan -> implementation -> review -> test -> commit loop.
- Each manager spawns exactly three **read/review-only peers** in one dedicated channel: engineer,
  security, and critic.
- Near the final gate, each manager uses one **independent cold reviewer** over DM only. It never
  joins or reads the feature channel, so panel consensus cannot anchor its second opinion.

The default runtime for every manager and reviewer is OpenCode, model `openai/gpt-5.6-sol`, variant
`high`. Change that only when the user explicitly asks.

## Hard rules

- Never switch the coordinator's branch. Create worktrees from a named committed base.
- One manager per feature, one reviewer per channel lane, and one independent DM-only reviewer per
  feature. No sibling instances or tester fan-out unless the user requests it.
- Managers alone edit their feature worktree. Reviewers only read, run non-mutating checks, and post
  findings with file/line references.
- Each feature uses one channel: `review.<feature-slug>`. Keep acknowledgements and status chatter
  off it; use it for plans, findings, reasoned dispositions, code-review requests, and final results.
- The independent reviewer is never invited to that channel and never receives its transcript,
  panel findings, or consensus. It reports privately to the feature manager.
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
model: openai/gpt-5.6-sol
variant: high
description: Owns <feature> and its review panel.
tags: [manager, <slug>]
subscribe: [general, review.<slug>]
allowSubscribe: [general, review.<slug>]
allowPublish: [general, review.<slug>]
capabilities: [spawn]
---
```

The manager prompt must include all of the following:

- Exact feature contract, branch, and absolute worktree path.
- Own the feature end to end and commit only intended feature files.
- Read repo instructions, current docs, and `.internal` before editing.
- Join `review.<slug>` first.
- Spawn exactly `review-engineer`, `review-security`, and `review-critic` with:
  `agent=opencode`, `model=openai/gpt-5.6-sol`, `variant=high`, and its feature worktree as `cwd`.
- DM each returned reviewer identity to join the channel and remain read/review-only.
- Run plan review before editing, code/test review after implementation, fold valid findings, and ask
  all three for a final disposition.
- After the panel and implementation converge, spawn exactly one `review-freelance` with the same
  OpenCode model, variant, and worktree. Keep it DM-only and read/review-only. Give it the original
  feature contract, actual diff/commit, test results, and review question, but do not summarize or
  forward panel discussion. Ask for an independent `APPROVE` or concrete findings.
- Fold or reason against the independent findings. If a fold changes code, return the result to the
  channel panel for another final pass and ask the independent reviewer to recheck its finding.
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
agent: opencode
model: openai/gpt-5.6-sol
variant: high
cwd: /absolute/path/to/feature-worktree
```

Launch managers in parallel only after all worktrees, personas, and channels exist. The manager may
auto-number repeated reviewer persona identities (`review-engineer-2`, etc.); track the returned
identity, not an assumed name.

Verify with `cotal_roster` that every manager appears and each has exactly three reviewer peers.
Do not spawn missing-looking duplicates prematurely; allow startup time and recheck first.

The independent reviewer is intentionally absent during initial staffing. The feature manager
spawns it only at the cold-review gate. Confirm it remains off the feature channel; communicate by
DM only. Auto-numbering applies to `review-freelance` too, so track the returned identity.

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
- Engineer, security, and critic all give final approval.
- The DM-only independent reviewer gives final approval without having joined the panel channel.
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
