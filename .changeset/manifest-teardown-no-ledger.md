---
"@cotal-ai/cli": patch
---

`cotal down -f <file>` in a root with no ledger from the retired `spawn -f` deploy no longer asks whether the manifest was edited and offers a run ID. It says the root holds no such ledger and names `cotal team remove <id>` for a `team deploy` deployment and `cotal down --dry-run` for the whole-stack preview. When ledgers exist and none matches, it lists their run IDs and the `--run <id> --dry-run` preview.
