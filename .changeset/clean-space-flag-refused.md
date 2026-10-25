---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal clean store`, `clean all` and the restore targets refuse `--space`, `--server` and `--creds`
`USAGE_INVALID` before local cleanup inspects or removes root state. They act on the root of the folder they run in
and used to ignore those flags, so `clean store --space <other> --force` removed this folder's store.
`clean history` keeps them.
