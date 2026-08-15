# M-RC1 RESULT — KILLED on exactly the one predicted cell

Preregistered at `815df558`; this file is a later commit. Closing sweep `date -u`:
**2026-08-15 03:18:42Z**.

## Result

`bin/smoke/ready-card.smoke.ts`: the recursive descent removed (1× unique, unique in both
directions). Through `scripts/mutation-proof.mjs`:

**KILLED**, red and named on
`COMPARATOR: the fingerprint SEES a write to a descendant of an already-existing marker dir`.
**30 marks against a baseline of 31 — a delta of exactly one**, matching the prediction that
exactly ONE cell would notice. Predicting one rather than "the suite goes red" is what makes this
a result: an unrelated early failure is also red.

Restore verified with `git diff --quiet`; mutant marker grepped back to 0.

## A DIAGNOSIS THAT CHANGED THE FIX — the first recursive version was WRONG

The first cut walked all five `HOME_MARKERS` recursively, including `.claude`, and the real-home
invariance cell went **RED**. Rather than assume the fix was right and the cell was noise — or that
the CLI had a real hermeticity defect — the change was diffed path by path:

```
.claude/backups/.claude.json.backup.1786763492316         (rotation)
.claude/projects/-home-david-Cotal-wt-432/….jsonl         (another session's transcript)
.claude/projects/-home-david-Cotal-wt-fm-agui/….jsonl     (another session's transcript)
.claude/projects/-home-david-Cotal-wt-fm-health/….jsonl   (this session's own transcript)
```

**18 changed entries, every one of them written by another tool, none by the CLI under test.** A
grep of the CLI source for HOME-rooted write targets returns `.agents`,
`claude-plugin`/`.claude-plugin`, `agent-skills.json`, `onboarded.json` — and **no `.claude` path
at all**.

So the invariance walk is scoped to `COTAL_WRITE_MARKERS`. A cell that reddens for reasons
unrelated to the code under test is not extra strictness: **it trains its reader to ignore a red,
which costs what a false green costs.** The residual limit — a regression writing specifically into
`~/.claude/projects` or `~/.claude/backups` would not be caught — is named in the source rather
than left implied.

This is also why the red was worth diagnosing instead of suppressing: the same red could have been
a genuine hermeticity defect, and only the path-level diff distinguishes the two.

## Why review's CLAIM 1 is now actually closed

The old `HERMETIC-control` cell proved only that the comparator could see a **top-level creation**
in a scratch home that started empty — and it stays GREEN under M-RC1, exactly as predicted. That
is the "shape of a sound argument without its substance" review named. The new pair supplies the
substance:

- `COMPARATOR` — the fingerprint sees a write to a descendant of an **already-existing** marker dir
- `COMPARATOR-control` — the **old top-level-only form does not**, so the repair is non-equivalent

## Closing sweep — suites, named as suites

| run | result |
| --- | ------ |
| `smoke:ready-card` | **28 passed, 0 failed**, rc=0 |
| `smoke:shard-status` | **32 passed, 0 failed**, rc=0 |
| `smoke:delivery-health` | **38 passed, 0 failed**, rc=0 |
| `smoke:delivery-health-live` | **17 passed, 0 failed**, rc=0 |
| `smoke:liveness-snapshot` | **20 passed, 0 failed**, rc=0 |
| `smoke:build-current` | **38 passed, 0 failed**, rc=0 |
| `smoke:gate-inventory` | rc=0 |
| `typecheck` | rc=0, **0 `error TS` lines** — measured separately |

A note on that last row: `typecheck` first hit a 2-minute command bound and was **reported as
unmeasured rather than assumed green**, then re-run under a longer bound. rc read from an EXIT-trap
artifact, never from a pipe. Tree: 0 uncommitted entries.

## Not claimed

- **NO GATE.** `smoke:ci` was NOT run. Every row above is a suite and is named as one.
- M-RC1 proves the suite **depends** on the recursive walk. It does not prove a production entry
  point reaches it; the comparator cells build their tree by hand, deliberately, so that the probe
  never touches anyone's real home.
- No live broker.
