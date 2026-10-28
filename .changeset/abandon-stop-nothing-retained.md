---
"@cotal-ai/cli": patch
---

`cotal down --abandon-stop <id> --yes` run again after a successful abandon had stopped the stack refused "no member of this stack retains a stop request with that ID" and sent the operator to `cotal down --dry-run` to see what blocks the stop, or to a `cotal service status <definition> --instance <id>` command with placeholders, though nothing blocked and the stack was not running. When no member retains any stop request, the `TARGET_NOT_FOUND` refusal now says "no member of this stack retains a stop request; nothing was abandoned" and names `cotal up` as Next, or `cotal down` while the stack runs. A member that retains a different stop request still gets the refusal that names it.
