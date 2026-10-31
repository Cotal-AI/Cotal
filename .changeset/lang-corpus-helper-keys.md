---
"@cotal-ai/lang": patch
---

The shipped conformance corpus (`conformance/corpus.json`) now carries the ninth example in the language reference: the reusable-helper example under §10.2 "Keys", which #5446 added to the spec. That change did not regenerate the corpus, so the corpus held only 8 of the reference's 9 examples. The corpus is regenerated with `pnpm gen:conformance`, and the new case is an accepted program.
