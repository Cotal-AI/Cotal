---
"@cotal-ai/cli": patch
---

`cotal chat` now refuses a typed `@<name>` that names no present peer and no sender the session heard from when it is chosen, with the reason a send to it would get, and opens the recipient list. Before, `:to @niemand` in `--plain`, or `@niemand` in the terminal view's picker, became the recipient, and every confirmed message then came back `denied: no peer "niemand" in this space`.
