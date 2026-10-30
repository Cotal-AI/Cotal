---
"@cotal-ai/cli": patch
---

`cotal doctor auth` without `--space`, run in the root of a space that was prepared and never started, now says to start that space with `cotal up` and then run the same command again. It used to say to run the command in a space's root folder, where the user already was. The report is still partial (exit 4), and `--fix` there still refuses `AUTH_REQUIRED`, with the same step.
