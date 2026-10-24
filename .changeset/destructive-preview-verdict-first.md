---
"@cotal-ai/cli": patch
---

`reset space --dry-run` and `space delete --dry-run` now open with a verdict, as `reset store --dry-run` does: the apply is offered with its `--yes` command, or it would refuse with its reason and remedy. `space delete --dry-run` no longer repeats that refusal as a warning after its text report; `--json` still carries it as a warning and as `applyBlockedBy`.
