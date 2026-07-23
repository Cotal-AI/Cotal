# Example 05 — Quorum Code Review

Point it at a public GitHub PR and it runs a resample-and-vote review **live on Cotal**: one
three-persona team, run **N times in strict isolation**, keeping only the findings that show up in
**≥ k of N** runs. The transport is the v0.4 endpoint surface — a `scatter` fans one request to
every instance of a service and gathers one schema-clean, attributed reply each.

```
(cd examples/05-quorum-code-review && pnpm run review -- --mock)
```

```
[mock] reviewing https://github.com/example/repo/pull/1
  3 instances, keep findings in >= 3 of 3 runs

scatters:
  bughunter  complete=true runs=3 missing=0 churn=0 duplicate=0
  keeper     complete=true runs=3 missing=0 churn=0 duplicate=0
  sweeper    complete=true runs=3 missing=0 churn=0 duplicate=0

survived the 3-of-3 vote: 2 finding(s)
  [HIGH] src/auth.ts:42  (support 3/3)
    off-by-one on the token loop bound also trips the boundary test, which can no longer fail
  [MED] src/cache.ts:17  (support 3/3)
    cache entry written before the DB commit; a rollback leaves a stale read
```

## What it demonstrates

- **N instances ARE the N runs.** One reviewer endpoint (`ai.cotal.reviewer`) with N instances;
  each serves three persona commands (`review-bughunter` / `review-keeper` / `review-sweeper`).
  Two instances reviewing the same PR with the same persona are two independent samples.
- **Isolation is structural, not prompt-enforced.** The `scatter` verb fans one request to every
  instance and gathers one reply each; replies ride the caller's own nonce-scoped rail, and there
  is no shared channel. No instance is on the path of another instance's reply.
- **Schema-clean replies, no repair pass.** Findings are ajv-validated at the serving boundary and
  again caller-side by the scatter, so the orchestrator never sees a malformed finding.
- **Broker-derived attribution.** Every reply's `(instanceId, epoch)` comes from the reply subject,
  so grouping by `instanceId` reconstructs the runs — an instance can't be misattributed.
- **Deadlines and partial results for free.** A quota-hung instance becomes a reported `missing`
  run, not a silent hang; `churn` / `duplicate` are classified, not guessed.
- **The vote stays application code.** Cotal has no quorum / k-of-N / clustering primitive; it hands
  you N isolated, attributed samples and the "kept if in ≥ k runs" filter is yours (`vote.ts`).

## Why isolation matters

The isolation is the whole game: if the runs can see each other, their findings correlate and the
k-of-N filter stops removing noise. Putting reviewers in one shared channel with endorsements leaks
exactly that correlation, and a prompt line ("you do not see other reviewers' output") is a request,
not a guarantee. On the endpoint surface the guarantee is structural — the scatter delivers the same
request to each instance independently and each reply is addressed to the caller alone.

### Isolation fidelity (honest note)

This example runs on a **single local broker** and enforces each instance's command surface **in
code** — through its authorized serve grant — exactly as `@cotal-ai/core`'s own smoke tests do. That
gives real structural isolation: no shared channel, per-caller nonce-scoped reply rails, and
broker-derived attribution; the smoke asserts that a *foreign* caller sees none of the
orchestrator's replies. The stronger wire-level default-deny — a *malicious* instance provably
**cannot** subscribe to another instance's rail even if it tries — is a credential-scoping property
minted by the auth layer for a secured space, and is out of scope here.

## Prerequisites

- Node ≥ 20, pnpm, and `nats-server` on PATH (macOS: `brew install nats-server`).
- Build core once, from the repo root: `pnpm install && pnpm -r build`.
- For a **real** run (not `--mock`): `opencode` on PATH with a configured model
  (`COTAL_REVIEW_MODEL`, default `openai/gpt-5.5`); `GITHUB_TOKEN` is optional (lifts the rate limit);
  `COTAL_REVIEW_TIMEOUT_MS` caps each model call (default 600000). A real run starts with a model
  canary — one tiny call — so a missing CLI or an exhausted quota fails fast instead of hanging.

## Run it

```bash
# mock — canned findings, no model quota, no network
(cd examples/05-quorum-code-review && pnpm run review -- --mock)

# real — a live model on a public PR
(cd examples/05-quorum-code-review && pnpm run review -- https://github.com/OWNER/REPO/pull/N)
```

Options: `--instances N` (default 3) and `--k K` (default 3, i.e. unanimity). For the demo the
reviewer daemon and the orchestrator run in one process against one local broker; in a real
deployment the daemon is long-lived and separately provisioned, and the orchestrator is a plain
core-client that connects, freezes the live instance set, and scatters.

## How it works

1. Start a local broker and provision the `ai.cotal.reviewer` service (its two-digest contract
   closure is pinned, so every instance registers the identical contract).
2. The reviewer daemon registers N instances and serves the three persona commands; each handler is
   a fresh, stateless model call (serialized per instance for OpenCode's SQLite lock).
3. The orchestrator builds the PR packet, `freezeExpectedSet` → the run set, then **three scatters**
   (one per persona) against that frozen set.
4. Group replies by `instanceId` into runs → merge the three personas within each run → cluster the
   findings across runs → keep the clusters with support ≥ k.

## Self-test

```
(cd examples/05-quorum-code-review && pnpm run smoke)
```

A mock end-to-end check: broker up, the reviewer daemon with three instances, the orchestrator on a
fixture PR. It asserts three complete scatters over three attributed instances, that the runs
reconstruct, that the k-of-N vote keeps the shared findings and votes out the per-instance noise, and
that a foreign caller's reply rail receives nothing.
