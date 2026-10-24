---
"cotal-ai": patch
---

With both `FORCE_COLOR` and `NO_COLOR` set, the CLI no longer prints Node's raw warning that
`NO_COLOR` is ignored. `FORCE_COLOR` still wins, as `cotal config` shows, and every other runtime
warning still prints.
