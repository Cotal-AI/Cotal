---
"@cotal-ai/workspace": patch
---

The user-mode control connect decides its `--creds` and non-user-mode refusals once. `connectUserControlOrExit` prints that sentence and exits, so it can no longer drop the recovery clause or skip the `--creds` refusal.
