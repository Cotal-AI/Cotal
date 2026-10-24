---
"@cotal-ai/cli": patch
---

Every command that takes `--server` refuses a URL with a user name or password in it `USAGE_INVALID`, exit 1, before it reads, writes or dials anything, and does not repeat the value. The NATS client keeps only a broker URL's host and port, so before, a command such as `send`, `history`, `ps`, `status` or `join` dropped those credentials in silence and connected with the credential it resolved. `up` keeps its own refusal.
