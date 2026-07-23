# The reviewer personas

The exact reviewer definitions behind the benchmark numbers. Source of truth is `src/bench.ts`
(the `TRIO` array and `promptFor`); this file is the readable copy.

## The winning team (select with `COTAL_BENCH_PERSONAS=bug-hunter,keeper,sweeper`)

- **bug-hunter** — "logic and correctness: behavior contradicting intent, broken control flow,
  subtle single-line defects"
- **keeper** — "data integrity and API misuse: partial writes, cache invalidation, stale reads,
  lost updates, misused framework APIs, misleading code"
- **sweeper** — "minor but real defects a thorough reviewer still notes: dead or unreachable
  code, tests that cannot fail or no-op, stale docstrings/comments that contradict behavior,
  invalid or misspelled properties/identifiers/metric tags, truthiness checks that break on
  0/empty/None, unawaited async calls, wrong-variable and copy-paste slips. LOW severity
  findings are expected and welcome"

A fourth tilt, **breaker** ("security and hostile conditions: auth bypass, injection, secret
exposure, race conditions, concurrent access, malformed inputs"), is defined but not part of the
winning team: the golden set skews correctness/data-loss, and security-tilted seats
underperformed on it (see EXPERIMENTS.md).

## The shared prompt frame

Every reviewer gets the same prompt skeleton; only name and tilt are swapped in. The key line:

> A real defect of any category outranks an on-theme observation; your tilt is only a
> tiebreaker when choosing where to dig deeper.

Plus: full changed files before the diff (`COTAL_BENCH_FULL_FILES=1`), at most 8 findings ranked
by severity, the soft filter ("report real defects, including likely-real ones you are not fully
certain about; when unsure, include it and mark severity LOW; never flag missing tests, style
preferences, or speculation without a concrete failure mode"), the v2 reporting rules
(`COTAL_BENCH_PROMPT_V2=1`), isolation rules (no goldens, no other reviewers' output, no web,
JSON only), and the `{path, line, severity, body}` output shape. The full template is
`promptFor()` in `src/bench.ts`.

## The mechanism that actually wins

The personas alone do not beat the commercial tools; a single run of this team is mid-pack.
The winning configs run the same team N times independently and keep only findings that appear
in >= k runs (`src/majority.ts`). See EXPERIMENTS.md for the support curves and the twins
experiment measuring how little the tilt wording itself contributes.
