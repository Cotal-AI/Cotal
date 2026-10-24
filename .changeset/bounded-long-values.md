---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

A refusal that repeats an over-long argument, such as an unknown command or subcommand, a space name given to `use` or `--space`, or a run id, now shows its first 128 characters and its length. A 100000-character value used to print a line as long as itself. The command still checks and uses the whole value.
