# 07 · Issue orchestrator: one lane per GitHub issue

Resolve GitHub issues in this repository as durable workflow runs. Each issue gets a **lane**: a
worker reproduces it, fixes it and opens a PR, two reviewers from two different model families
grade the PR at an exact sha, and a merger merges that sha. Several lanes run at once, each in its
own worktrees, and a lane that cannot reproduce its issue stops without a fix.

The coordination is two [cotal-lang](../../docs/workflows.md) programs. The manager hosts them, so a
run survives a closed terminal and a manager restart, and its step journal shows where every lane
stands.

## Prerequisites

- Node ≥ 22, pnpm, and `nats-server` (v2.11+). Install deps once, from the repo root: `pnpm install`.
- A static-auth mesh with a manager, from `cotal up` (not `--open`, not `--user-auth`). Hosted runs
  need issued caller authority, which only a static-auth mesh provides.
- `gh`, authenticated for this repository, on the manager's PATH.
- The harness and provider for each persona's model: `claude` (triage, worker, merger), `codex`
  (reviewer A), `opencode` (reviewer B).
- The five personas in the mesh's persona catalog: copy `agents/*.md` to `<project>/.cotal/agents/`.

## Check the programs

No mesh needed:

```
cd examples/07-issue-orchestrator && pnpm check
```

`check` validates both programs, then runs four scripted outcomes through the dry run, the tree-walker
and the compiled engine a manager runs programs on. It exits non-zero on any refusal, or when a lane
record or step list differs from what the script expects.

```
happy path: reproduce, PR, two approvals, merge (resolve-issues.cotal.js)
    outcome merged, 24 settled steps, 5 spawns, 0 checkpoints
not reproduced: the lane stops before any fix (resolve-issue.cotal.js)
    outcome not-reproduced, 6 settled steps, 1 spawns, 1 checkpoints
one block, a fix, then two approvals at the new sha (resolve-issues.cotal.js)
    outcome merged, 34 settled steps, 5 spawns, 0 checkpoints
two blocks reach the review cap (resolve-issues.cotal.js)
    outcome blocked, 31 settled steps, 4 spawns, 0 checkpoints
check: all passed
```

## Run it

**1. Start the mesh** from your project folder, seeding the two lane channels:

```
pnpm cotal up --detach --channels examples/07-issue-orchestrator/channels.json
```

**2. Start a run.** Several issues, chosen by the triage seat:

```
pnpm cotal run start --file examples/07-issue-orchestrator/programs/resolve-issues.cotal.js
```

The triage seat runs `gh issue list` with the filter in `agents/triage.md` (open, labelled `bug`,
unassigned, no linked PR) and picks at most three reproducible issues. The run caps the list at three
lanes either way.

One issue you name:

```
pnpm cotal run start --file examples/07-issue-orchestrator/programs/resolve-issue.cotal.js
pnpm cotal run answer <runId> "/checkpoint:issue#0" --value '{"issue": 1877}'
```

**3. Follow it.**

```
pnpm cotal run ps
pnpm cotal run journal <runId>
```

`journal` prints each step under its key (`/fanOut:lanes#0/b:1877/ask:opened#0`), with what an open
pause asks beneath it. The run logs one record per lane when it ends:

```
{ issue, outcome, sha, pr, mergeSha, rounds, blockers }
```

`outcome` is `merged`, `not-reproduced`, `blocked` (review cap reached), `merge-refused`, or `failed`
(a step failed; the first blocker names the code).

**4. Stop it.** From the project folder:

```
pnpm cotal run revoke <runId> --local --by <you> --reason "<why>"
```

## How a lane runs

1. `spawn` the worker into logical worktree `issue-<n>`, `turn` it to reproduce, `ask` for
   `{ reproduced, evidence }`. Not reproduced ends the lane.
2. `turn` it to fix, test and open the PR, `ask` for `{ sha, pr }`.
3. `fanOut` over reviewers A and B, each spawned into `review-<n>-a` or `review-<n>-b`. Each gets a
   `notify` with the PR and sha, a `turn` to grade, and an `ask` for `{ verdict, sha, blockers }`. A
   verdict that names another sha counts as a block.
4. On any block: the worker gets one more round (`turn` address, `ask` the new sha and PR), and the
   same reviewers re-grade the delta. After two review rounds the lane returns `blocked` with the
   blockers.
5. On two approvals at one sha, `spawn` the merger into `merge-<n>`, `turn` it to merge that PR at
   that sha, `ask` for `{ merged, mergeSha }`. The merger uses `gh pr merge --match-head-commit`, so
   GitHub refuses a head that moved.

A lane catches its own step failures and returns a `failed` record, so one failed lane never cancels
the others.

## Two programs, one lane

A program is one module with no imports, so the lane function lives in both files, verbatim, between
the `// ---- lane: begin` and `// ---- lane: end ----` markers. `pnpm check` fails if the two blocks
differ, which keeps them from drifting. The single-lane file takes its issue from a checkpoint
because a program has no other input. The driver is the one to use for real work.

## Pieces

| File | Role |
|---|---|
| `programs/resolve-issues.cotal.js` | The driver: triage picks issues, one lane per issue in a `fanOut` keyed by the issue number. |
| `programs/resolve-issue.cotal.js` | One lane for an issue the operator names at the `issue` checkpoint. |
| `agents/triage.md` | Selects issues through `gh` only. |
| `agents/issue_worker.md` | Reproduces, fixes, opens and updates the PR. Never merges. |
| `agents/reviewer_a.md`, `agents/reviewer_b.md` | Cold reviewers on two model families, neither the worker's. Read no channel. |
| `agents/merger.md` | Merges the approved sha or refuses. Never edits code. |
| `channels.json` | `#issues.lanes` (worker and merger status lines) and `#issues.review` (reviewers post, never read). |
| `src/check.ts` | The four scripted runs behind `pnpm check`. |

## Limits

What the runtime enforces:

- No two agents in one logical worktree at once (L3022 when the program is validated, L4008 while
  it runs). Every worktree id derives from the issue number, so lanes never share one.
- The `ask` schema: a reply missing a field or of the wrong kind costs an attempt; two bad replies,
  or no reply within 30 minutes, fail the step (L4006), and the lane ends `failed`.
- Turn and wall-clock permits per seat (`permits` on each `spawn`; L4001 past them).
- The channel grants in each persona's frontmatter, which the broker enforces.

What only the personas promise:

- That a logical worktree maps to a real git worktree. The runtime tracks the id; the manager starts
  every seat in the project folder and creates no git worktree. Each persona creates its own.
- That the worker reproduced the issue before fixing it, that the reviewers graded the sha they name,
  and that the worker never merges and the merger never edits code.
- **Every persona holds `capabilities: [run]`**, which is wider than an `ask` needs. A seat answers
  an `ask` through the manager's run-answer command, and today only the `run` capability grants it
  ([#1877](https://github.com/Cotal-AI/Cotal/issues/1877)). With `run` a seat can also start, resume
  and answer any run on the mesh. The personas are told to answer only their own asks, and nothing
  in the runtime holds them to it.
- The relay shows a seat the shell line `cotal run answer ... --by <seat>`, which the hosted path
  refuses. The personas answer with the `cotal_run` tool instead.

A user-auth mesh hosts no runs, hosted or local, so this example needs a static-auth mesh.
