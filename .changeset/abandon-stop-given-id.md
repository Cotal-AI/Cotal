---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal down --abandon-stop <id> --yes` given an ID that no stack member retains, such as the operation ID of the `down` that sent the stop, refused `TARGET_NOT_FOUND` with that ID in its fields as `Original request`, the label the `LIFECYCLE_BLOCKED` refusal over a retained stop gives the real stop request ID. The refusal now shows it as `Given ID`. Other refusals keep `Original request`, and the `--json` shape is unchanged: `target.requestId` still carries the given ID.
