---
"@cotal-ai/cli": patch
---

`persona create` refuses a role that `send -r` cannot reach, one that is not a single token of
letters, digits, `_` and `-`, from `--role` or from a file's `role`, instead of saving it.
