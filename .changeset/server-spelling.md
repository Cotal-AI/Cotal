---
"@cotal-ai/cli": patch
---

`cotal up --server` records and compares the broker address with the scheme in lower case and without a bare trailing `/`. A stack first started with `--server NATS://127.0.0.1:<port>/` is no longer refused `CONFLICT` as moved to another address when a later `up` passes `--server nats://127.0.0.1:<port>`. A path, query or fragment is still refused.
