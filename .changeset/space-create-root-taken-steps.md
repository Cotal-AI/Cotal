---
"@cotal-ai/cli": patch
---

`cotal space create <name>` in a folder another space already uses refused with "create the space in another folder, or pass --root <dir>", even to a caller who had just passed `--root`, and named no step for the space already there. The next step now names creating it in another folder with `--root <dir>` (`--project <dir>` for `setup`), and starting, selecting or forgetting the space that uses the folder.
