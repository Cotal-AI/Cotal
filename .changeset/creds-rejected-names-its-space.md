---
"@cotal-ai/workspace": patch
---

A `--creds` credential the broker rejects now names the space it belongs to when its own permissions name one other space: `credentials rejected at <server>: <file> is a credential for space "<owner>", not "<space>"`, still `PERMISSION_DENIED`, exit 2. The Next is `--space <owner>`, and with `--space` given it also names `cotal auth mint` for the space that was asked for. Before, every such rejection said only "check your creds, or the broker wants different auth". The structured target carries `credentialSpace`.
