---
"@cotal-ai/workspace": patch
---

`cotal attach` keeps reconnecting when the user-auth service does not answer its base bearer exchange, as it already did for the manager-caller exchange and an unreachable broker. The base exchange's failure was classified as a permanent refusal, so a reconnect that reached a slow or restarting auth service exited with `the user-auth service ... did not answer` instead of trying again. A first attach still exits on it, and a refused base exchange or a sign-out still ends a reconnect.
