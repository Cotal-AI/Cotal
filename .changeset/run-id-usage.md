---
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

A malformed run ID is now one usage refusal on every `cotal run` verb that takes one. `show`, `journal`, `answer`, `amend`, `resume`, `revoke` and `check` refuse an ID that is not 1 to 64 letters, digits, `_` or `-` with `USAGE_INVALID`, exit 1, naming the format, before anything is contacted. Before, the same local check came back as exit 5 on `show` and `journal`, exit 3 "Outcome unconfirmed" on `answer`, `amend` and `resume`, and an unformatted error on `revoke` and `check`.
