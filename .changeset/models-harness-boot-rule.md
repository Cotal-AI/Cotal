---
"@cotal-ai/manager": patch
---

`cotal models` now decides whether a connector's harness is present with the same rule spawn and resume use. It used to look the harness binaries up on PATH again on every request, while a launch decides from the manager's boot inventory, so a harness installed after boot was listed by `models` and refused by spawn, and a harness removed after boot was refused by `models` while spawn still launched from the boot path. The catalog now reports the reason boot recorded when a connector's row is unavailable, and the `<name> harness needs <bin> on PATH - not found` sentence is built in one place.
