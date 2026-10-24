---
"@cotal-ai/runtime": patch
---

A hosted `cotal run revoke` now gets one refusal whether or not it passes `--by`: it names `--local --by <actor> --reason <text>`, which revoke requires. Before, `run revoke <id> --by <who>` was told that `--by` is only for the local path, while `run revoke <id>` was told it requires `--by`.
