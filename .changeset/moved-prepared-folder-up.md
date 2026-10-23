---
"@cotal-ai/cli": patch
---

A bare `cotal up` in a prepared project folder that was moved no longer starts the legacy launcher under the default "main" space. A prepared space records its folder by path, so after the move nothing in the folder names it, and `up` fell back to the default. When the selected space is prepared in a folder that no longer exists and the current folder names no space, `up` now refuses `TARGET_UNAVAILABLE` (exit 2) with nothing written, and says to forget the space and prepare it again in its new folder, or to pass `--space` to start another space there. `space create <name>` for a space whose recorded folder no longer exists now says so and says to forget it first, rather than "start it with `cotal up` there".
