---
"@cotal-ai/cli": patch
---

`cotal service add <name> --preset broker --help` shows `--server <url>`, as the missing-option refusal and the bare `service` row do, where it showed `--server <string>`. The `--log-file` description no longer starts with "absolute path of", since `add` makes a relative path absolute.
