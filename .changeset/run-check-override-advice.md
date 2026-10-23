---
"@cotal-ai/runtime": patch
---

`cotal run check` no longer tells you to pass `--discard-approvals` when an edit drops an answered checkpoint, an override that `run check` refuses because it decides what a migration commit does. The L5004 reason now says to keep the checkpoint in the edited program, or to discard the decision in a migration commit under the `--discard-approvals` override.
