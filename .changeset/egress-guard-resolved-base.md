---
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

Grade the frozen-body egress guard against the predicate it actually replaced, instead of a pinned historical floor. The differential resolved its base as a fixed sha, so a guard could become stricter than that floor, be weakened back toward it, and still report zero weaker rows. The base is now resolved from history: the newest ancestor whose `agui.ts` differs from the source under test and still carries a classifier role, with the working tree as the head so an uncommitted weakening is graded, and an on-demand deepen so the pair exists in a depth-1 CI checkout. `COTAL_EGRESS_DIFF_BASE` adds a pair against an explicit PR base and never replaces one. Two holes the resolved run exposed are closed with it: the loader folded an unrecognised verdict into a throw, which would have read a new publishing verdict as withheld, and the closed-schema branch had no row naming it.
