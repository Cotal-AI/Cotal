# M-R6 — REVIEW'S mutant, run at my tip. Predicted cell for cell, including the greens.

Their finding: my probe-as-writer arm covers ONE read order. The writer is the probe, so a second
read placed BEFORE `probe(...)` never sees a changed file. They preregistered it, `mutation-proof`
said **SURVIVED** at 14/0, and a real concurrent writer reached the violation at iteration 114 of
100,000.

| | predicted | observed |
| --- | --- | --- |
| RED | `R1`, `R2` | **exactly those two, by name** |
| `S5` | **GREEN — the finding, reproduced** | **GREEN** |
| rc | 1 | **1** |
| marks | 18 (baseline 20) | **18 (baseline 20)** |

Restore verified: the mutated file matches HEAD.

## The prediction that mattered was about a cell staying GREEN

**`S5` passing under this mutant IS the reviewer's finding.** The real-file arm has no writer before
the probe, so both reads return 101, the probe gets 101, and 101 comes back. The old suite could not
see this mutant at all — which is why it survived there and dies here. Had `S5` gone red I would
have mis-built the mutant, not caught something extra.

## Why the repair is a seam and not a sentence

The first response available was to widen the claim in the header, or to add a stochastic cell with
a concurrent writer and enough iterations to be likely to catch it. Neither is a guarantee: prose
does not fail, and a cell that finds a defect at iteration 114 of 100,000 can also miss it.

Injecting the reader — the same way the probe was already injected, for the same reason — makes both
orders deterministic. `R1` counts the reads, so a second one anywhere through the seam is one too
many regardless of position. `R2` asserts the invariant itself against a reader whose answer changes
on every call, so *probed ≠ returned* fails with no concurrency at all.

## What is still NOT covered, stated plainly

A second read that **bypasses the injected reader** — a direct `readFileSync` inside the helper —
would not move `R1`'s counter. That is exactly what the probe-as-writer arm still covers for the
post-probe position, and it is **uncovered for the pre-probe position**. Naming it rather than
implying the seam is total: the honest claim is *two independent arms, each with a known blind
spot, and the blind spots do not overlap for the post-probe case but do for the pre-probe one*.
