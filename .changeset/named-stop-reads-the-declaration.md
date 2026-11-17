---
"@cotal-ai/cli": patch
---

`cotal down delivery`, its `--dry-run` and a named set such as `cotal down manager delivery --dry-run` work after a whole-stack `down`. Before, they refused `TARGET_NOT_FOUND` for the `delivery.creds` file that the whole-stack stop removed. A stop and its preview now read only the adapter's declaration, not the launch options.
