---
"@cotal-ai/cli": patch
---

The comment in `cotal ext remove`'s process description, which ships in the CLI's compiled output, now states the labelling rule in three lines: only a pid proven dead is called a "stale pidfile", because that label is advice to delete the record, while unattributable content and indeterminate liveness are named as such. It replaces three blocks that narrated earlier revisions and said "three labels" above code with four. No runtime change.
