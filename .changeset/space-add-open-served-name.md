---
"@cotal-ai/cli": patch
---

`cotal space add --mode open` now checks that the broker serves a space by that name, as its streams show. A name it does not serve, such as a typo, is refused with `TARGET_NOT_FOUND` naming the spaces it does serve. Before, an open broker's answer was enough, so the mistyped space was recorded as healthy and every later operation on it failed without naming the name.
