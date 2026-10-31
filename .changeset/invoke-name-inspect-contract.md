---
"@cotal-ai/cli": patch
---

`cotal invoke manager <command> --name <agent>` resolves its target again. Since invoke fetched only the invoked command's contract, the `inspect` lookup behind `--name` was refused locally with `TARGET_NOT_FOUND` before anything was published. Invoke now fetches `inspect`'s contract with the command's when `--name` names a manager target.
