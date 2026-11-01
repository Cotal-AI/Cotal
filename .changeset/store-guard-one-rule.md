---
"@cotal-ai/cli": patch
---

The store cleanup guard keeps one rule for a `--store-dir` inside `.cotal`, instead of also checking a partial list of `.cotal` children that never changed the outcome.
