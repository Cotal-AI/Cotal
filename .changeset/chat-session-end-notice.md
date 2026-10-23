---
"@cotal-ai/cli": patch
---

`chat` now shows when a static or signed-in session ends: the banner gives the time, and a notice a
minute before says the session is ending. In `--plain`, `/quit` leaves a session that has already
ended. It used to be answered with "end input (Ctrl-D) to leave".
