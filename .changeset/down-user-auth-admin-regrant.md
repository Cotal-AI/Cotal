---
"@cotal-ai/manager": patch
---

On a user-auth stack, `cotal down` after `cotal login` refused with "ask the stack operator to stop this shared manager", even for the person who started the stack, because the signed-in `cli` grant had no `admin` scope. That refusal now names the whole-row `cotal actor grant` that adds `admin` to the current grant, with every other field the row holds today, as the auth plane prints it from the ledger. After that grant, `cotal down` stops the stack. No other caller is tried, and a grant that already holds `admin` keeps the manager's refusal as it was.
