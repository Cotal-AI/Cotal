---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
---

`cotal run start`, `resume`, `ps`, `journal` and `answer` now re-describe and re-issue an unpinned manager call that a sibling manager refused before running it, up to the same 16 attempts the CLI's manager commands use. Before, one such refusal ended the command, so in a space with two managers about half of these calls failed with a refusal saying the command was not run. A hosted run's own manager calls now use that bound too instead of 8. The repair is one core helper, `invokeRepairingSplit`, which the CLI and the runtime both call.
