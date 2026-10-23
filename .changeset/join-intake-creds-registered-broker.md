---
"@cotal-ai/cli": patch
"@cotal-ai/delivery": patch
---

`join --creds` or `--token` and `feedback-intake --creds` with no `--server` now dial the broker the
space is registered at, keeping its TLS requirement, and refuse an unregistered space before any
dial. Before, they sent the credential to the default address.
