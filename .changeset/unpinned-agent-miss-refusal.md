---
"@cotal-ai/cli": patch
---

`cotal stop`, `input` and `attach` without `--on`, on a space with several managers, now refuse a
name no manager runs `TARGET_NOT_FOUND` with exit 2, naming the managers that answered and `cotal ps`
as Next, as the same miss with `--on` does. `--json` prints the refusal envelope. A search that some
manager did not answer refuses `TARGET_UNAVAILABLE`. Both used to print one bare line and exit 1.
