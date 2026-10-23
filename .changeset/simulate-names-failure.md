---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run simulate` now tells a program that fails under its script apart from a script that does not cover the program. A program failure, such as a checkpoint scripted `expired` under the default `onExpiry: "fail"` (L4007), is a completed simulation, exit 0, whose program outcome is failed: it shows the step and that step's outcome with the language's error, and the JSON result carries `outcome` and `failure` beside the effects that ran. A script with no result for an effect (L6001) still does not complete, exit 5, and now names the step and the entry to add. Before, both printed "the offline simulation did not complete; unscripted effects are not invented" with a null result. `dryRunOutcome` returns a failed program's report with its fault, and `dryRun` takes an optional `journal`, so a caller can read the step a dry run that did not complete stopped at.
