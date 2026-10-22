---
"@cotal-ai/cli": patch
---

`cotal spawn --foreground` refuses an actor whose foreground material another session holds, or that already has a grant, with `CONFLICT` and exit 2. Since the command-line redesign it reported that refusal as an unconfirmed outcome with exit 3, though nothing had been launched or issued.
