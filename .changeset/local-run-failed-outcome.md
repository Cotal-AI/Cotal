---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run start --local` and `cotal run resume --local` of a program that fails now report the
failure the run's status records: `OPERATION_FAILED`, exit 5, naming the run, its language code and
the first line of its message, with `cotal run show <runId> --local` as the next step. Before, they
reported an unknown outcome, exit 3, with the whole multi-line message flattened onto one line as
literal `\u000a` escapes and no next step. Any other error the drive ends on is still unknown.
