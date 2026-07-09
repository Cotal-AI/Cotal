# Example 05: local Code Review Bench harness

Run Cotal-style cross-vendor reviews against Martian's offline Code Review Bench without creating GitHub fork repos or installing a GitHub App.

The harness keeps the review lane and judge lane separate:

- Review lane: OpenCode models review public PR patches. Default pair is `opencode-go/glm-5.2` and `openai/gpt-5.5-fast`.
- Judge lane: Martian's existing Python scorer can evaluate the frozen Cotal candidates with a direct OpenAI-compatible `MARTIAN_*` endpoint, or the harness can run an OpenCode-backed local judge fallback.

Reviewers never receive `golden_comments/*.json`. The harness only reads golden comments after reviewer output is frozen so it can write Martian-compatible `benchmark_data.json` and `candidates.json`.

## Setup

```bash
pnpm --filter @cotal-ai/example-05-code-review-bench-local setup
pnpm --filter @cotal-ai/example-05-code-review-bench-local preflight
```

Defaults can be overridden:

```bash
COTAL_BENCH_GLM_MODEL=opencode-go/glm-5.2 \
COTAL_BENCH_GPT_MODEL=openai/gpt-5.5-fast \
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:one
```

## Run

```bash
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:one
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:three
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:pilot
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:all
```

Outputs go under `.runs/code-review-bench/<run-id>/` and are not committed.

If `MARTIAN_API_KEY` and `MARTIAN_BASE_URL` are not set, `run` automatically uses the local OpenCode judge fallback. Override the judge model with:

```bash
COTAL_BENCH_JUDGE_OPENCODE_MODEL=openai/gpt-5.5 \
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:one
```

To re-score the latest generated Martian inputs:

```bash
pnpm --filter @cotal-ai/example-05-code-review-bench-local judge:local
```

### Direct OpenAI judge (e.g. GPT-5.2)

To judge with a model that is only reachable through a metered OpenAI API key rather than an
OpenCode subscription (for example `gpt-5.2`, the model Martian scores its public leaderboard
with), set `COTAL_BENCH_JUDGE_OPENAI_API_KEY`. `judge:local` then calls the OpenAI Chat
Completions API directly instead of shelling out to OpenCode, and writes results under
`results/<model>_openai_direct/`:

```bash
COTAL_BENCH_JUDGE_OPENAI_API_KEY=sk-... \
COTAL_BENCH_JUDGE_OPENAI_MODEL=gpt-5.2 \
pnpm --filter @cotal-ai/example-05-code-review-bench-local judge:local
```

Optional: `COTAL_BENCH_JUDGE_OPENAI_BASE_URL` (default `https://api.openai.com/v1`) for an
OpenAI-compatible endpoint, and `COTAL_BENCH_JUDGE_LIMIT=N` to judge only the first N PRs. The
scoring (bipartite golden-to-candidate match) is identical to the OpenCode judge, so the two
paths are directly comparable; the only difference is which model produced the matches.

`run:pilot` samples one PR from each golden-comment source file before applying its limit, so it covers the five offline repos instead of the first five sorted entries.

## Teams

`COTAL_BENCH_TEAM` selects the reviewer set (also switches the results tool key):

- `council` (default, tool key `cotal-council`): the 9-perspective glock-style council with weights and vetoes.
- `trio` (tool key `cotal-trio`): the data-derived 3-generalist team (bug-hunter, breaker, keeper) with generalist-first prompts and a maintainer-would-block self-filter, derived from the council run's miss/noise analysis.

Set the same variable when running `judge:local`, `variants`, and `attribute` so they read the matching tool key.

## Reliability

Long runs are designed to survive failures:

- Before the PR loop and before judging, a canary pings each model with a tiny prompt and a 2 minute timeout (`COTAL_BENCH_CANARY_TIMEOUT_MS`). Exhausted provider quotas make `opencode run` hang silently, and the canary turns that into a fast, clear error. Skip with `COTAL_BENCH_SKIP_CANARY=1`.
- Network fetches retry 3 times with backoff; reviewer, repair, and judge calls retry once on timeout.
- A PR that still fails is skipped and recorded (`error.txt` in its run dir, `failures` in `run.json`); the run continues and reports skips at the end.
- Interrupted runs resume without repeating paid work: `pnpm --filter @cotal-ai/example-05-code-review-bench-local exec tsx src/bench.ts run --resume <runId>` reuses each PR's cached `findings.json` and re-runs only the rest.

## Per-vendor attribution and severity variants

After judging, attribute every TP/FP back to the reviewer that produced it (no extra model calls):

```bash
pnpm --filter @cotal-ai/example-05-code-review-bench-local attribute
```

To score only high-severity candidates as a separate variant (writes to a `_sev-HIGH` results dir, never overwrites the main results):

```bash
COTAL_BENCH_SEVERITY_FILTER=HIGH \
pnpm --filter @cotal-ai/example-05-code-review-bench-local judge:local
COTAL_BENCH_SEVERITY_FILTER=HIGH \
pnpm --filter @cotal-ai/example-05-code-review-bench-local attribute
```

Severity data flows from reviewer output into `candidates.json`, so variants only work for runs produced after this feature was added.

## Local judge caveats

The OpenCode local judge fallback is not Martian's official judge, and its numbers are not comparable to Martian-scored results:

- It skips Martian's `step2_5` semantic dedup, so semantically equivalent findings from the GPT and GLM reviewers each count as separate candidates and inflate false positives.
- It matches all candidates for a PR against the golden comments in one OpenCode call, unlike Martian's pairwise Python judge.
- Because the harness combines GPT and GLM output without semantic dedup, low precision (roughly 0.2 on the full 50-PR run) is expected and does not by itself indicate a reviewer regression.

Fallback results are written under `results/<judge-model>_opencode_local/` and their `summary.json` records the judge model. Always label these results as "OpenCode local judge fallback"; only results produced with the `MARTIAN_*` direct API path are Martian-official.

## Score With Martian

If you have a direct OpenAI-compatible judge endpoint:

```bash
cd .runs/code-review-bench/martian/offline
uv sync
MARTIAN_API_KEY=... \
MARTIAN_BASE_URL=... \
MARTIAN_MODEL=openai/gpt-5.5 \
uv run python -m code_review_benchmark.step2_5_dedup_candidates --tool cotal-cross-vendor
MARTIAN_API_KEY=... \
MARTIAN_BASE_URL=... \
MARTIAN_MODEL=openai/gpt-5.5 \
uv run python -m code_review_benchmark.step3_judge_comments --tool cotal-cross-vendor --dedup-groups results/openai_gpt-5.5/dedup_groups.json
uv run python analysis/benchmark_dashboard.py
```

If GPT is only available through OpenCode and not as a direct API endpoint, use the local judge fallback for smoke tests and label the result as `opencode-gpt-judged`.
