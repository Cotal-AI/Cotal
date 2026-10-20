---
"@cotal-ai/cli": patch
---

`cotal service status` now refuses the units `cotal service uninstall` refuses: one with no provenance header, one with no recorded mesh, and one recorded for another mesh. Before, status reported an operator-written unit, or another mesh's unit, as this mesh's installed service, and uninstall then refused to remove it. Both commands check a unit's provenance through one function on Linux and macOS, so each refusal is worded once and reads correctly from either command.
