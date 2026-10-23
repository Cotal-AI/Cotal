---
"@cotal-ai/cli": patch
---

`cotal channel` and its subcommands now report a target they cannot use, such as a space that is prepared but not started, the way `ps`, `who` and `history` do: a refusal under its own code, such as `TARGET_UNAVAILABLE`, in one JSON envelope with `--json`, exit 2, and the remedy under Next. They printed one line and exited 1, the usage exit, with no JSON.
