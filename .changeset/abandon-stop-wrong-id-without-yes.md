---
"@cotal-ai/cli": patch
---

`cotal down --abandon-stop <id>` without `--yes`, given an ID that no stack member retains, such as the operation ID of the `down` that sent the stop, told the operator to rerun it with `--yes` "to give it up", and that rerun only refused `TARGET_NOT_FOUND`. The ID is now looked up first, with nothing written, so such an ID refuses `TARGET_NOT_FOUND`, naming the stop request a member retains and its `--abandon-stop` command, with or without `--yes`. An ID a member retains still asks for `--yes` as before.
