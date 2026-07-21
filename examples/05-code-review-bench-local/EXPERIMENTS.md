# What moves an AI code-review team's score, and what does not

Every experiment below ran on Martian's Code Review Bench (50 real PRs from cal.com, Grafana,
Keycloak, Discourse, Sentry; 136 human golden review comments) with GPT-5.5 reviewers via OpenCode
and a GPT-5.2 judge over the direct OpenAI API (the same judge model Martian scores its public
leaderboard with; our judge reproduces their leaderboard on their own published candidates to
~0.016 mean absolute F1 error). Precision counts every candidate that matches no golden as a false
positive, so the benchmark rewards matching what humans chose to comment on, not raw bug-finding.

## Recovery audit (2026-07-14)

- Harness: `example/gateway-council`, commits `5e26275`, `5219499`, and `4c6c1a4`; TypeScript and
  preflight pass. The local Martian clone is at `949e4a1`.
- Raw artifacts: 2.7 GB under repository-root `.runs/`. Base runs are in `.runs/code-review-bench`,
  cross-judge results in `.runs/rejudge{,-gpt52}`, full-file/aim runs in `.runs/fullfiles`, support
  sweeps in `.runs/majority`, and leaderboard rescoring in `.runs/rescore-tools`.
- The raw summaries reproduce the headline results: aimed duo `.4159/.4146`, two independent
  three-run unanimity sets `.4632/.4565`, and six-run support thresholds 4/6 `.4654`, 5/6 `.46595`.
- The archived mesh result is not a valid 50-PR comparison. Its run manifest maps five synthetic
  Keycloak/Sentry PRs onto duplicate Discourse URLs, leaving 45 unique PRs and 122 goldens. The
  resolver now derives the exact URL from each run-directory slug and refuses partial coverage;
  the corrected mapping resolves 50 unique PRs and all 136 goldens. Do not cite the mesh delta until
  a corrected run is complete.
- `.runs/freshset/golden_comments` is empty. The `hexaX/Y/Z` artifacts are interrupted five-PR
  smokes with no summary, not results.

Next experiment: freeze 15 merged PRs created after 2026-07-10, three per source repository, and
curate human inline review comments before generation. Run the locked bug-hunter/keeper/sweeper
team three times with isolated contexts, cluster centrally at 3/3 support, and compare against the
locked aimed duo. Start with three PRs and stop on any data leak or failure rate above 5%. The full
run proceeds only if every artifact records reviewer and judge tokens, latency, failures, and the
golden-freeze timestamp. Success means the filtered swarm beats both its single-run mean and the duo
by at least `.03` F1 without losing more than `.05` recall; otherwise the tuned result does not
transfer. A corrected mesh smoke is a separate publication prerequisite, not the next quality search.

## Scoreboard (chronological; each row changes one thing)

| config | P | R | F1 | verdict |
|---|---|---|---|---|
| 9-persona weighted council | .157 | .588 | .248 | elaborate loses: "right file, wrong issue" |
| naive 2-model pair, diff only | .186 | .706 | .294 | recall champion, noise cannon |
| breaker+keeper duo, diff only | .331 | .441 | .379 | the honest small-team baseline |
| duo + FULL CHANGED FILES | .333 | .485 | .395 | context = +recall, precision flat |
| bug-hunter+keeper duo + full files | .356 | .500 | .416 | AIM at the golden skew = +both (stable n=2) |
| + sweeper (3rd reviewer for minor-but-real) | .33-.36 | .54-.57 | .41-.44 (n=6) | +5-10 goldens every run, noisy precision |
| swarm x3 runs, majority (>=2/3) vote | .367 | .537 | .436 | frontier shift: highest multi-reviewer P |
| swarm x3 runs, UNANIMOUS (3/3) findings | .45-.46 | .463 | .457-.463 | confirmed on 2 independent trios |
| swarm x6 runs, 4-of-6 vote | .407 | .544 | .465 | more runs = finer dial, more recall kept |
| swarm x6 runs, 5-of-6 vote | .455 | .478 | .466 | best 6-run cut |
| swarm x9 runs, 7-of-9 vote | .466 | .507 | **.486** | ceiling; .479 under a second judge (gpt-5.5) |

Same-judge comparison against the leaderboard tools' own published findings: cubic-v2 .579,
qodo-extended-v2 .563, **ours .486** (9-run 7-of-9; .457-.463 at 3/3 unanimity), Cursor Bugbot
.445, greptile-v4 .415, Claude Code .375, CodeRabbit .352, Copilot .346, Gemini .325.

## The three levers that worked

1. **Full-file context** (`COTAL_BENCH_FULL_FILES=1`): reviewers see the complete changed files at
   the PR head, not just diff hunks. Pure recall gain (+6 TP), precision unchanged.
2. **Team aim**: point reviewers at the distribution humans actually comment on. The golden set
   skews correctness/data-loss, so bug-hunter (correctness) + keeper (data-integrity) beat
   breaker (security) combinations; a third "sweeper" persona for minor-but-real defects (dead
   code, stale docstrings, falsy-0 guards, unawaited async) recovers goldens neither hunter is
   incentivized to report. Aim was the only generation-side variable that ever moved F1.
3. **Cross-RUN voting** (`src/majority.ts`): run the same team N times independently, cluster
   findings by underlying issue, keep those found in >=k runs. Unanimity (3/3) bought +.10
   precision for -.07 recall. Findings that reproduce across resamples are disproportionately the
   ones humans flagged. This is Cursor Bugbot's documented core mechanism, and it transfers.
   With 6 runs the support curve is: k=2 F1 .387 (80 TP, our recall ceiling), k=3 .434, k=4 .465,
   k=5 .466 (peak), k=6 .442 (over-filtered). More runs give a finer dial; 4-of-6 and 5-of-6 both
   beat 3-of-3. With 9 runs (swarm2-4 + swarmA-C + swarmD-F, 2022 findings clustered) precision
   climbs monotonically with required support, .335 / .375 / .410 / .466 / .484 / .517 for k=4..9,
   while F1 peaks at .486 at k=7 (69 TP) and falls off at k=8-9 as over-filtering sets in. The
   7-of-9 candidate set scores .479 under a gpt-5.5 judge (68 TP, delta .007), so the peak is
   dual-judge robust. Reading the exact peak off the curve is itself a test-set choice; the claim
   that holds is the curve's shape. Artifacts: `.runs/majority/nine*.json`,
   `.runs/majority/worker-nine-s{4..9}`, `.runs/majority/worker-nine-s7-gpt55`.

## Open-weights replication (GLM-5.1, 2026-07-16/21)

Same recipe as the swarm rows above (bug-hunter/keeper/sweeper trio, full files, 3 independent
runs, cross-run voting), with GLM-5.1 as the reviewer model and the same gpt-5.2 judge:

| GLM-5.1 config | P | R | F1 |
|---|---|---|---|
| single runs (x3) | .220 / .202 / .255 | .559 / .500 / .596 | .315 / .288 / .357 |
| 2-of-3 vote | .268 | .522 | .354 |
| 3-of-3 unanimous | .421 | .390 | .405 |

The voting mechanism transfers, and the noisier model gains more from it: unanimity nearly
doubles GLM's precision (.226 mean to .421) and buys +.085 F1, versus roughly +.04 for the
GPT-5.5 swarm from the same 3/3 filter. Consistent with the resampling story: reproducibility
filtering removes sampling noise, and the model with more sampling noise has more to remove.
Artifacts: `.runs/fullfiles/glm{1,2,3}`, `.runs/majority/glm*.json`,
`.runs/majority/worker-glm-s{2,3}`.

## The scorer null (the campaign's sharpest negative)

We then built the leaders' documented filter design: a reflect pass scoring every cross-run
cluster 0-10 against the patch with an impact rubric, trigger-feasibility steps, and the support
count as context (`src/score.ts`), expecting to recover recall by keeping high-scoring
low-support findings. It does not discriminate AT ALL: keep score>=7 alone gives P .278 (base
rate), and every (support OR score) hybrid scores BELOW its pure-support base because the added
high-score singletons are almost all false positives. Combined with the five dead post-hoc
filters and two dead verify passes, the conclusion is now overdetermined for this benchmark:
NO content-based judgment separates "golden" from "plausible but uncommented"; the ONLY signal
that does is behavioral - whether independent runs reproduce the finding. Filter on
reproducibility, not on content.

## The graveyard (all tested to a verdict, most twice)

- **Coordination hurts.** Reviewers sharing a live channel (full Cotal mesh) or a debate round
  anchor on each other and re-endorse instead of covering new ground: recall drops, precision
  flat. Consensus across DIFFERENT reviewers is the same signal as independent agreement, minus
  the coverage. (Voting across RESAMPLES of the same team is the opposite case, and works.)
- **Retrieval is null.** A scout pass fetching the exact extra repo files the reviewer requested
  (avg 5.6/PR) moved F1 by +0.001 with identical recall. The misses were never about missing code.
- **Instructions are outcome-neutral for fixed aims.** Our best selection rules (diff-anchored
  claims only, no hypothetical-caller edge cases, golden register, family splitting, depth floor)
  plus an LLM dedup pass visibly reshaped the output (comment length halved, duplicates gone) and
  reproduced the baseline F1 EXACTLY, to five decimals.
- **Post-hoc filters die.** Consensus-across-personas, peer debate, maintainer triage, severity
  cuts, weighted approval, and two research-backed verify passes (concrete-trigger gate + eliminate
  rubric) all dropped true positives as fast as false ones. Cause: ~80% of false positives are
  real bugs humans simply did not comment on; no second look at the same text can separate them.
  Severity gating is actively harmful: FPs look MORE severe than TPs here.
- **Model shopping (on our accounts) is closed.** gpt-5.6* is Codex-blocked or hangs via OpenCode
  and absent from the API; gpt-5.5-pro is Responses-API-only and structurally infeasible under a
  50k tokens-per-minute org limit when review prompts run ~60k tokens.

## Mechanics worth knowing

- n=50 with an LLM judge carries ~±0.015-0.02 run-to-run F1 noise; single-run rankings inside that
  band are meaningless. Confirm anything you want to claim.
- The judge is a single-call bipartite matcher (no semantic dedup). Martian's official pipeline
  adds dedup + pairwise judging worth ~0.03-0.04 F1; we verified the gap by re-scoring the
  leaderboard tools' own candidates with our judge.
- Reviewer prompts, per-PR artifacts, and all evaluation JSONs are written under `.runs/` for
  every run; `--resume <runId>` reuses cached reviewer findings so filters/merges re-score fast.

## Reproducing the best config

```bash
# one swarm run (repeat 3x with different labels)
COTAL_BENCH_FULL_FILES=1 COTAL_BENCH_PROMPT_V2=1 COTAL_BENCH_DEDUP=1 \
COTAL_BENCH_TEAM=trio-r COTAL_BENCH_PERSONAS=bug-hunter,keeper,sweeper \
pnpm --filter @cotal-ai/example-05-code-review-bench-local run:all

# unanimity across the three runs' candidates.json files
npx tsx src/majority.ts out/candidates.json 3 \
  runA/candidates.json:toolA runB/candidates.json:toolB runC/candidates.json:toolC
# then judge the merged candidates (judge:local with COTAL_BENCH_TOOL=cotal-majority)
```

Caveats we disclose: team aims and the sweeper were derived by analyzing misses on THESE 50 PRs
(mild test-set tuning); the PRs predate model cutoffs (contamination inflates recall for every
recent-model tool including the leaderboard); a fresh-PR confirmation set is the right next step
before treating any head-to-head number as final.
