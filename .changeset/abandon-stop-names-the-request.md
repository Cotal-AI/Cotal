---
"@cotal-ai/cli": patch
---

After an interrupted whole-stack stop, `cotal status` named the earlier stop's operation ID in its `Stack blocked` line while its Next named the stop request ID that `cotal down --abandon-stop` takes, with neither labelled. A user who copied the ID from the sentence was refused `TARGET_NOT_FOUND` with no ID to use instead. The line now labels both, as `operation <id>` and `stop request <request-id>`, and the `up` and `down` refusals over a retained stop name its stop request ID. `cotal down --abandon-stop` given any other ID, the operation ID included, still refuses `TARGET_NOT_FOUND` and now names the stop request each member retains, with its `--abandon-stop` command as Next. The `--json` shapes are unchanged.
