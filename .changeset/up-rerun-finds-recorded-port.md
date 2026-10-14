---
"@cotal-ai/cli": patch
---

A bare re-run of `cotal up` now finds this folder's own mesh when its first boot ran on an auto-selected port. The re-run started from the default URL, missed the record, picked another free port, and was refused with `space "<space>" is already in use by a mesh at <url>`, so a refresh or repair needed `--server` by hand. With no `--server`, `cotal up` now starts from the URL this root recorded for the space, and `--host` keeps that URL's port.
