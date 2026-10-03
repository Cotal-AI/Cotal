---
"@cotal-ai/core": minor
---

Breaking: a flag given more than once is now a usage error unless the command declares it repeatable (`multiple`), as `FlagSpec.multiple` already documented. `parseCommandArgs` used to keep the last value with no error, so `cotal down web --space a --space b` acted on `b`, and a wrapper that checked the first value verified a different target than the command used. The CLI now prints `Option '--space' cannot be repeated` with the command's help and exits 1 before the command runs. `-f` and `--file` count as the same flag, and a word after `--` stays a positional. Repeatable flags such as `--opt` and `down --session-store` still collect every value. A script that repeats a flag to override an earlier value must pass it once.
