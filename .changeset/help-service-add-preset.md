---
"@cotal-ai/cli": patch
---

Explicit `help service add` now shows the selected preset's options, as the suffix `--help` form does. `help` accepts `--preset <name>` and renders the preset-augmented add help; an unknown preset still falls through to the generic add help.
